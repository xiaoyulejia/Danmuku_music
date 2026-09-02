"""Keep Bilibili LiveHime and its child processes responsive in background.

The program applies one fixed profile only:

1. Set livehime.exe and all descendants to HIGH_PRIORITY_CLASS.
2. Disable Windows Power Throttling/EcoQoS for those processes.

It never changes window state, focus, position, visibility, or topmost status.
When LiveHime is not running, its executable is discovered from Windows process,
registry, shortcuts, and common installation locations before being launched.
"""

from __future__ import annotations

import argparse
import ctypes
import logging
import os
import re
import subprocess
import sys
import time
from ctypes import wintypes
from itertools import chain
from pathlib import Path
from typing import Iterable

import psutil
import winreg


LOGGER = logging.getLogger("livehime-priority-guard")
DEFAULT_PROCESS = "livehime.exe"
CREATE_NO_WINDOW = 0x08000000


class ProcessPowerThrottlingState(ctypes.Structure):
    """Windows PROCESS_POWER_THROTTLING_STATE structure."""

    _fields_ = (
        ("Version", wintypes.ULONG),
        ("ControlMask", wintypes.ULONG),
        ("StateMask", wintypes.ULONG),
    )


KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
KERNEL32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
KERNEL32.OpenProcess.restype = wintypes.HANDLE
KERNEL32.SetProcessInformation.argtypes = (
    wintypes.HANDLE,
    ctypes.c_int,
    ctypes.c_void_p,
    wintypes.DWORD,
)
KERNEL32.SetProcessInformation.restype = wintypes.BOOL
KERNEL32.CloseHandle.argtypes = (wintypes.HANDLE,)
KERNEL32.CloseHandle.restype = wintypes.BOOL
KERNEL32.GetLogicalDrives.argtypes = ()
KERNEL32.GetLogicalDrives.restype = wintypes.DWORD
KERNEL32.GetDriveTypeW.argtypes = (wintypes.LPCWSTR,)
KERNEL32.GetDriveTypeW.restype = wintypes.UINT

PROCESS_SET_INFORMATION = 0x0200
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_POWER_THROTTLING = 4
PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1
PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1
PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION = 0x4
DRIVE_FIXED = 3

UNINSTALL_REGISTRY_PATH = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"
APP_PATHS_REGISTRY_PATH = (
    r"Software\Microsoft\Windows\CurrentVersion\App Paths\livehime.exe"
)
LIVEHIME_DISPLAY_NAMES = ("直播姬", "livehime", "bilibili live")


def disable_process_power_throttling(pid: int) -> None:
    """Disable EcoQoS execution and timer-resolution throttling for a process."""

    access = PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION
    handle = KERNEL32.OpenProcess(access, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())

    try:
        state = ProcessPowerThrottlingState(
            Version=PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask=(
                PROCESS_POWER_THROTTLING_EXECUTION_SPEED
                | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION
            ),
            StateMask=0,
        )
        if not KERNEL32.SetProcessInformation(
            handle,
            PROCESS_POWER_THROTTLING,
            ctypes.byref(state),
            ctypes.sizeof(state),
        ):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        KERNEL32.CloseHandle(handle)


def find_root_processes(executable_name: str) -> list[psutil.Process]:
    """Find all processes whose executable name matches *executable_name*."""

    executable_name = executable_name.casefold()
    roots: list[psutil.Process] = []
    for process in psutil.process_iter(["name"]):
        try:
            if (process.info["name"] or "").casefold() == executable_name:
                roots.append(process)
        except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied):
            continue
    return roots


def find_process_tree(executable_name: str) -> list[psutil.Process]:
    """Find matching root processes and all recursive descendants."""

    roots = find_root_processes(executable_name)
    processes: dict[int, psutil.Process] = {process.pid: process for process in roots}
    for root in roots:
        try:
            for child in root.children(recursive=True):
                processes[child.pid] = child
        except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied):
            continue
    return list(processes.values())


def configure_process(
    process: psutil.Process,
    configured: set[tuple[int, float]],
    denied: set[tuple[int, float]],
) -> tuple[int, float] | None:
    """Apply high priority and disabled power throttling to one process."""

    try:
        key = (process.pid, process.create_time())
        name = process.name()
        # Reapply every pass in case Windows or Chromium backgrounds it again.
        process.nice(psutil.HIGH_PRIORITY_CLASS)
        disable_process_power_throttling(process.pid)
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return None
    except (psutil.AccessDenied, OSError) as exc:
        fallback_key = (process.pid, 0.0)
        if fallback_key not in denied:
            LOGGER.warning("Cannot configure pid=%s: %s", process.pid, exc)
            denied.add(fallback_key)
        return fallback_key

    denied.discard((process.pid, 0.0))
    if key not in configured:
        LOGGER.info(
            "Applied priority=high and disabled Power Throttling/EcoQoS "
            "for %s (pid=%s)",
            name,
            process.pid,
        )
        configured.add(key)
    return key


def extract_executable_path(value: str | os.PathLike[str] | None) -> Path | None:
    """Extract an existing .exe path from a registry or shortcut value."""

    if not value:
        return None
    text = os.path.expandvars(os.fspath(value)).strip()
    if not text:
        return None

    quoted = re.match(r'^"([^"]+\.exe)"', text, flags=re.IGNORECASE)
    if quoted:
        text = quoted.group(1)
    else:
        exe_end = text.casefold().find(".exe")
        if exe_end >= 0:
            text = text[: exe_end + 4]
        else:
            text = text.split(",", 1)[0]

    candidate = Path(text.strip().strip('"')).expanduser()
    try:
        candidate = candidate.resolve()
    except OSError:
        return None
    return candidate if candidate.is_file() else None


def normalize_executable_path(value: str | os.PathLike[str] | None) -> Path | None:
    """Extract and validate a livehime.exe path."""

    candidate = extract_executable_path(value)
    if candidate and candidate.name.casefold() == DEFAULT_PROCESS:
        return candidate
    return None


def unique_existing_candidates(
    candidates: Iterable[tuple[Path | None, str]],
) -> Iterable[tuple[Path, str]]:
    """Yield valid candidates once, preserving discovery priority."""

    seen: set[str] = set()
    for candidate, source in candidates:
        if candidate is None:
            continue
        try:
            resolved = candidate.expanduser().resolve()
        except OSError:
            continue
        key = str(resolved).casefold()
        if key in seen:
            continue
        seen.add(key)
        if resolved.is_file() and resolved.name.casefold() == DEFAULT_PROCESS:
            yield resolved, source


def candidates_from_running_processes(process_name: str) -> Iterable[tuple[Path, str]]:
    """Get executable paths from already-running LiveHime processes."""

    for process in find_root_processes(process_name):
        try:
            yield Path(process.exe()), f"running process pid={process.pid}"
        except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied):
            continue


def registry_views() -> Iterable[tuple[int, int]]:
    """Yield registry hive/access pairs for user, native, and WOW64 views."""

    views = (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY)
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in views:
            yield hive, winreg.KEY_READ | view


def safe_registry_value(key: winreg.HKEYType, name: str | None) -> str | None:
    try:
        value, _ = winreg.QueryValueEx(key, name)
    except OSError:
        return None
    return value if isinstance(value, str) else None


def candidates_from_registry() -> Iterable[tuple[Path, str]]:
    """Discover installation paths from App Paths and uninstall entries."""

    for hive, access in registry_views():
        try:
            with winreg.OpenKey(hive, APP_PATHS_REGISTRY_PATH, 0, access) as key:
                candidate = normalize_executable_path(safe_registry_value(key, None))
                if candidate:
                    yield candidate, "Windows App Paths registry"
        except OSError:
            pass

        try:
            uninstall = winreg.OpenKey(hive, UNINSTALL_REGISTRY_PATH, 0, access)
        except OSError:
            continue
        with uninstall:
            index = 0
            while True:
                try:
                    subkey_name = winreg.EnumKey(uninstall, index)
                except OSError:
                    break
                index += 1
                try:
                    subkey = winreg.OpenKey(uninstall, subkey_name, 0, access)
                except OSError:
                    continue
                with subkey:
                    display_name = (safe_registry_value(subkey, "DisplayName") or "").casefold()
                    if not any(name in display_name for name in LIVEHIME_DISPLAY_NAMES):
                        continue

                    install_value = safe_registry_value(subkey, "InstallLocation")
                    if install_value:
                        install_dir = Path(os.path.expandvars(install_value.strip('" ')))
                        for candidate in (
                            install_dir.parent / DEFAULT_PROCESS,
                            install_dir / DEFAULT_PROCESS,
                        ):
                            if candidate.is_file():
                                yield candidate, "uninstall registry InstallLocation"

                    display_icon = normalize_executable_path(
                        safe_registry_value(subkey, "DisplayIcon")
                    )
                    if display_icon:
                        yield display_icon, "uninstall registry DisplayIcon"

                    uninstall_path = extract_executable_path(
                        safe_registry_value(subkey, "UninstallString")
                    )
                    if uninstall_path:
                        for parent in (uninstall_path.parent, uninstall_path.parent.parent):
                            candidate = parent / DEFAULT_PROCESS
                            if candidate.is_file():
                                yield candidate, "uninstall registry UninstallString"


def candidates_from_shortcuts() -> Iterable[tuple[Path, str]]:
    """Resolve livehime.exe targets from Start Menu and desktop shortcuts."""

    powershell = r"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$roots = @(
    [Environment]::GetFolderPath('Programs'),
    [Environment]::GetFolderPath('CommonPrograms'),
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$shell = New-Object -ComObject WScript.Shell
Get-ChildItem -LiteralPath $roots -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object {
        try {
            $target = $shell.CreateShortcut($_.FullName).TargetPath
            if ((Split-Path -Leaf $target) -ieq 'livehime.exe') { $target }
        } catch {}
    }
"""
    try:
        result = subprocess.run(
            [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                powershell,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            creationflags=CREATE_NO_WINDOW,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return

    for line in result.stdout.splitlines():
        candidate = normalize_executable_path(line)
        if candidate:
            yield candidate, "Start Menu/Desktop shortcut"


def fixed_drive_roots() -> Iterable[Path]:
    """Yield local fixed-drive roots without recursively scanning disks."""

    drive_mask = KERNEL32.GetLogicalDrives()
    for index in range(26):
        if not drive_mask & (1 << index):
            continue
        root = f"{chr(ord('A') + index)}:\\"
        if KERNEL32.GetDriveTypeW(root) == DRIVE_FIXED:
            yield Path(root)


def candidates_from_common_locations() -> Iterable[tuple[Path, str]]:
    """Check shallow common installation paths on every fixed disk."""

    relative_directories = (
        Path("Program Files") / "livehime",
        Path("Program Files (x86)") / "livehime",
        Path("livehime"),
    )
    for drive in fixed_drive_roots():
        for relative in relative_directories:
            install_root = drive / relative
            direct = install_root / DEFAULT_PROCESS
            if direct.is_file():
                yield direct, "common installation location"
            if not install_root.is_dir():
                continue
            try:
                for version in install_root.iterdir():
                    candidate = version / DEFAULT_PROCESS
                    if version.is_dir() and candidate.is_file():
                        yield candidate, "versioned common installation location"
            except OSError:
                continue

    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        base = Path(local_app_data)
        for candidate in (
            base / "Programs" / "livehime" / DEFAULT_PROCESS,
            base / "livehime" / DEFAULT_PROCESS,
        ):
            if candidate.is_file():
                yield candidate, "per-user common installation location"


def discover_livehime_executable(
    process_name: str,
    explicit_path: Path | None,
) -> tuple[Path, str]:
    """Find LiveHime using explicit, process, registry, shortcut, then disk hints."""

    candidate_groups: list[Iterable[tuple[Path | None, str]]] = []
    if explicit_path is not None:
        explicit = normalize_executable_path(explicit_path)
        if explicit is None:
            raise FileNotFoundError(f"Invalid --launch-exe path: {explicit_path}")
        candidate_groups.append(((explicit, "--launch-exe"),))

    candidate_groups.extend(
        (
            candidates_from_running_processes(process_name),
            candidates_from_registry(),
            candidates_from_shortcuts(),
            candidates_from_common_locations(),
        )
    )

    for executable, source in unique_existing_candidates(chain.from_iterable(candidate_groups)):
        return executable, source
    raise FileNotFoundError(
        "Could not find livehime.exe. Start Bilibili LiveHime first, or run "
        'with --launch-exe "C:\\path\\to\\livehime.exe".'
    )


def launch_if_needed(process_name: str, explicit_path: Path | None) -> None:
    """Attach to LiveHime or discover and launch it normally."""

    roots = find_root_processes(process_name)
    if roots:
        paths = list(candidates_from_running_processes(process_name))
        if paths:
            LOGGER.info("Attached to running LiveHime: %s", paths[0][0])
        else:
            LOGGER.info("%s is already running; attaching by process name", process_name)
        return

    executable, source = discover_livehime_executable(process_name, explicit_path)
    LOGGER.info("Discovered LiveHime via %s: %s", source, executable)
    subprocess.Popen([str(executable)], cwd=str(executable.parent), close_fds=True)
    LOGGER.info("Launched %s", executable)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Set LiveHime and its descendants to high priority and disable "
            "Windows Power Throttling/EcoQoS. Window state is never changed."
        )
    )
    parser.add_argument(
        "--process",
        default=DEFAULT_PROCESS,
        help=f"root executable name (default: {DEFAULT_PROCESS})",
    )
    parser.add_argument(
        "--launch-exe",
        type=Path,
        help="optional explicit path; normally discovered automatically",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=1.0,
        help="seconds between child-process scans (default: 1.0)",
    )
    return parser.parse_args()


def pause_on_frozen_error() -> None:
    """Keep a double-clicked console open long enough to show a fatal error."""

    if getattr(sys, "frozen", False) and sys.stdin and sys.stdin.isatty():
        try:
            input("Press Enter to close...")
        except (EOFError, KeyboardInterrupt):
            pass


def main() -> None:
    args = parse_args()
    if args.interval <= 0:
        raise SystemExit("--interval must be greater than zero")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    LOGGER.info(
        "Fixed profile: priority=high, Power Throttling/EcoQoS=disabled, "
        "window control=disabled"
    )
    try:
        launch_if_needed(args.process, args.launch_exe)
    except (FileNotFoundError, OSError) as exc:
        LOGGER.error("%s", exc)
        pause_on_frozen_error()
        raise SystemExit(1) from exc

    configured: set[tuple[int, float]] = set()
    denied: set[tuple[int, float]] = set()
    missing_reported = False
    try:
        while True:
            processes = find_process_tree(args.process)
            if not processes:
                if not missing_reported:
                    LOGGER.info("%s is not running; waiting", args.process)
                    missing_reported = True
                time.sleep(args.interval)
                continue

            missing_reported = False
            live_keys: set[tuple[int, float]] = set()
            for process in processes:
                key = configure_process(process, configured, denied)
                if key is not None:
                    live_keys.add(key)

            configured.intersection_update(live_keys)
            denied.intersection_update(live_keys)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        LOGGER.info("Stopped")


if __name__ == "__main__":
    main()
