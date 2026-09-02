import musicPlayer from './music-player.js?v=20260902-3';
import musicServer from '../services/musicServers/music-server.js?v=20260902-3';

class QueueManager {
    constructor() {
        this.current = document.getElementById('queueCurrentSong');
        this.list = document.getElementById('sortableQueue');
        this.saveButton = document.getElementById('saveQueueOrder');
        this.cancelButton = document.getElementById('cancelQueueOrder');
        this.refreshButton = document.getElementById('refreshQueue');
        this.status = document.getElementById('queueManagerStatus');
        this.searchForm = document.getElementById('queueSearchForm');
        this.searchInput = document.getElementById('queueSearchInput');
        this.searchButton = document.getElementById('queueSearchButton');
        this.searchStatus = document.getElementById('queueSearchStatus');
        this.searchResultsElement = document.getElementById('queueSearchResults');
        this.originalOrderIds = [];
        this.draftOrderIds = [];
        this.orders = new Map();
        this.searchResults = [];
        this.stateRevision = 0;
        this.queueRevision = 0;
        this.currentOrderId = '';
        this.busy = false;
        this.searchBusy = false;
        this.draggingId = '';

        if (!this.list) return;
        window.addEventListener('damuku-room-state', event => this.applyState(event.detail));
        this.saveButton?.addEventListener('click', () => this.saveOrder());
        this.cancelButton?.addEventListener('click', () => this.cancelDraft());
        this.refreshButton?.addEventListener('click', () => this.refresh());
        this.searchForm?.addEventListener('submit', event => {
            event.preventDefault();
            this.searchSongs();
        });
        this.searchResultsElement?.addEventListener('click', event => {
            const button = event.target.closest('button[data-search-index]');
            if (!button) return;
            this.addSearchResult(Number(button.dataset.searchIndex));
        });
        this.list.addEventListener('click', event => this.handleListClick(event));
        this.list.addEventListener('pointerdown', event => this.startDrag(event));
        this.refresh();
    }

    setStatus(message, type = '') {
        if (!this.status) return;
        this.status.textContent = message;
        this.status.dataset.state = type;
    }

    setSearchStatus(message, type = '') {
        if (!this.searchStatus) return;
        this.searchStatus.textContent = message;
        this.searchStatus.dataset.state = type;
    }

    applyState(state) {
        if (!state || !Array.isArray(state.queue)) return;
        const keepDraft = this.isDraftDirty() &&
            this.queueRevision === (Number(state.queueRevision) || 0) &&
            this.currentOrderId === String(state.queue[0]?.orderId || '');
        this.stateRevision = Number(state.stateRevision) || 0;
        this.queueRevision = Number(state.queueRevision) || 0;
        this.currentOrderId = String(state.queue[0]?.orderId || '');
        this.orders = new Map(state.queue
            .map(order => [String(order.orderId || ''), order])
            .filter(([id, order]) => id && order && Number(order.uid) !== 0));
        const serverPendingIds = state.queue.slice(1)
            .filter(order => Number(order.uid) !== 0 && order.orderId)
            .map(order => String(order.orderId));
        // 相同 queueRevision 下保留本地草稿；一旦队列或当前歌曲发生变化，
        // 立即丢弃草稿并回到服务端权威顺序。
        if (!keepDraft) {
            this.originalOrderIds = serverPendingIds;
            this.draftOrderIds = serverPendingIds.slice();
        }
        this.render(state.queue[0] || null);
        if (!keepDraft) this.setStatus(serverPendingIds.length ? '' : '暂无可管理的待播歌曲');
    }

    render(currentOrder) {
        if (this.current) {
            const song = currentOrder?.song || currentOrder;
            this.current.textContent = song?.sname
                ? `${song.sname} - ${song.sartist || '未知歌手'}（${currentOrder?.uname || '空闲歌单'}）`
                : '暂无歌曲';
        }
        this.list.replaceChildren();
        this.draftOrderIds.forEach((orderId, index) => {
            const order = this.orders.get(orderId);
            if (!order) return;
            const item = document.createElement('li');
            item.className = 'sortableQueueItem';
            item.dataset.orderId = orderId;
            item.setAttribute('draggable', 'false');

            const handle = document.createElement('button');
            handle.type = 'button';
            handle.className = 'dragHandle';
            handle.textContent = '☰';
            handle.setAttribute('aria-label', `拖动${order.song?.sname || '歌曲'}`);
            item.appendChild(handle);

            const position = document.createElement('span');
            position.className = 'queuePosition';
            position.textContent = index === 0 ? '下一首' : `${index + 2}`;
            item.appendChild(position);
            for (const [className, value] of [
                ['queueSongName', order.song?.sname || ''],
                ['queueArtist', order.song?.sartist || '未知歌手'],
                ['queueRequester', order.uname || '']
            ]) {
                const span = document.createElement('span');
                span.className = className;
                span.textContent = value;
                item.appendChild(span);
            }

            const promote = document.createElement('button');
            promote.type = 'button';
            promote.className = 'promoteButton';
            promote.dataset.action = 'promote';
            promote.textContent = index === 0 ? '已是下一首' : '设为下一首';
            promote.disabled = index === 0 || this.busy;
            item.appendChild(promote);
            for (const [action, label, disabled] of [
                ['up', '上移', index === 0],
                ['down', '下移', index === this.draftOrderIds.length - 1]
            ]) {
                const move = document.createElement('button');
                move.type = 'button';
                move.className = 'moveButton';
                move.dataset.action = action;
                move.textContent = label;
                move.disabled = disabled || this.busy;
                item.appendChild(move);
            }
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'removeButton';
            remove.dataset.action = 'remove';
            remove.textContent = '删除';
            remove.disabled = this.busy;
            item.appendChild(remove);
            this.list.appendChild(item);
        });
        this.saveButton.disabled = this.busy || !this.isDraftDirty();
        this.cancelButton.disabled = this.busy || !this.isDraftDirty();
        if (this.searchButton) this.searchButton.disabled = this.busy || this.searchBusy;
        if (this.searchInput) this.searchInput.disabled = this.busy || this.searchBusy;
        this.searchResultsElement?.querySelectorAll('button[data-search-index]')
            .forEach(button => { button.disabled = this.busy || this.searchBusy; });
    }

    renderSearchResults() {
        if (!this.searchResultsElement) return;
        this.searchResultsElement.replaceChildren();
        this.searchResults.forEach((song, index) => {
            const item = document.createElement('article');
            item.className = 'queueSearchResult';
            const details = document.createElement('div');
            details.className = 'queueSearchSong';
            const name = document.createElement('strong');
            name.textContent = song.sname || '未命名歌曲';
            const metadata = document.createElement('span');
            const duration = Number(song.duration) > 0
                ? ` · ${Math.floor(Number(song.duration) / 60)}:${String(Math.floor(Number(song.duration) % 60)).padStart(2, '0')}`
                : '';
            metadata.textContent = `${song.sartist || '未知歌手'}${duration}`;
            details.append(name, metadata);
            const add = document.createElement('button');
            add.type = 'button';
            add.dataset.searchIndex = String(index);
            add.textContent = '加入队列';
            add.disabled = this.busy || this.searchBusy;
            item.append(details, add);
            this.searchResultsElement.appendChild(item);
        });
    }

    async searchSongs() {
        if (this.busy || this.searchBusy) return;
        const keyword = this.searchInput?.value.trim() || '';
        if (!keyword) {
            this.searchResults = [];
            this.renderSearchResults();
            this.setSearchStatus('请输入歌曲名或歌手名', 'error');
            this.searchInput?.focus();
            return;
        }
        this.searchBusy = true;
        this.searchResults = [];
        this.renderSearchResults();
        this.setSearchStatus('正在搜索网易云音乐…', 'loading');
        this.render(this.orders.get(this.currentOrderId));
        try {
            const server = musicServer.getServer('wy');
            this.searchResults = await server.searchSongs(keyword, 10);
            this.renderSearchResults();
            this.setSearchStatus(
                this.searchResults.length ? `找到 ${this.searchResults.length} 首歌曲，请选择要加入的歌曲` : '没有找到匹配的歌曲',
                this.searchResults.length ? 'success' : 'error'
            );
        } catch (error) {
            this.searchResults = [];
            this.renderSearchResults();
            this.setSearchStatus(error?.message || '搜索失败，请稍后重试', 'error');
        } finally {
            this.searchBusy = false;
            this.render(this.orders.get(this.currentOrderId));
        }
    }

    async addSearchResult(index) {
        const song = this.searchResults[index];
        if (!song || this.busy || this.searchBusy) return;
        this.busy = true;
        this.render(this.orders.get(this.currentOrderId));
        this.setSearchStatus(`正在加入“${song.sname}”…`, 'loading');
        try {
            const response = await musicPlayer.sendCommand('addOrder', {
                uid: -1,
                uname: '队列管理',
                source: 'manual',
                song
            });
            if (response?.state) musicPlayer.applySharedState(response.state);
            if (!response?.ok) {
                const reason = response?.result?.result?.reason || response?.result?.reason || response?.reason || '歌曲未能加入队列';
                this.setSearchStatus(reason, 'error');
                return;
            }
            this.setSearchStatus(`已将“${song.sname}”加入队列`, 'success');
        } catch (error) {
            this.setSearchStatus(error?.message || '加入队列失败，请稍后重试', 'error');
        } finally {
            this.busy = false;
            this.render(this.orders.get(this.currentOrderId));
        }
    }

    isDraftDirty() {
        return this.draftOrderIds.length !== this.originalOrderIds.length ||
            this.draftOrderIds.some((id, index) => id !== this.originalOrderIds[index]);
    }

    handleListClick(event) {
        const button = event.target.closest('button[data-action]');
        if (!button || this.busy) return;
        const item = button.closest('[data-order-id]');
        if (!item) return;
        const id = item.dataset.orderId;
        if (button.dataset.action === 'promote') this.promote(id);
        if (button.dataset.action === 'up') this.moveDraft(id, -1);
        if (button.dataset.action === 'down') this.moveDraft(id, 1);
        if (button.dataset.action === 'remove') this.remove(id);
    }

    startDrag(event) {
        if (this.busy || !event.target.closest('.dragHandle')) return;
        const item = event.target.closest('[data-order-id]');
        if (!item) return;
        event.preventDefault();
        this.draggingId = item.dataset.orderId;
        const currentOrder = this.orders.get(this.currentOrderId) || null;
        item.classList.add('is-dragging');
        item.setPointerCapture?.(event.pointerId);
        const move = moveEvent => {
            if (!this.draggingId) return;
            const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest('[data-order-id]');
            if (!target || target === item || !this.list.contains(target)) return;
            const rect = target.getBoundingClientRect();
            this.list.insertBefore(item, moveEvent.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
        };
        const finish = () => {
            item.classList.remove('is-dragging');
            this.list.removeEventListener('pointermove', move);
            this.list.removeEventListener('pointerup', finish);
            this.list.removeEventListener('pointercancel', finish);
            this.draggingId = '';
            this.draftOrderIds = [...this.list.querySelectorAll('[data-order-id]')].map(node => node.dataset.orderId);
            this.render(currentOrder);
            if (this.isDraftDirty()) this.setStatus('顺序尚未保存', 'dirty');
        };
        this.list.addEventListener('pointermove', move);
        this.list.addEventListener('pointerup', finish, { once: true });
        this.list.addEventListener('pointercancel', finish, { once: true });
    }

    moveDraft(orderId, delta) {
        const index = this.draftOrderIds.indexOf(orderId);
        const next = index + delta;
        if (index < 0 || next < 0 || next >= this.draftOrderIds.length) return;
        [this.draftOrderIds[index], this.draftOrderIds[next]] = [this.draftOrderIds[next], this.draftOrderIds[index]];
        this.render(this.orders.get(this.currentOrderId));
        this.setStatus('顺序尚未保存', 'dirty');
    }

    async promote(orderId) {
        if (!orderId || !this.orders.has(orderId)) return;
        this.busy = true;
        this.render(this.orders.get(this.currentOrderId));
        this.setStatus('正在设置下一首…', 'loading');
        const response = await musicPlayer.sendCommand('promoteNext', {
            orderId,
            expectedQueueRevision: this.queueRevision,
            expectedCurrentOrderId: this.currentOrderId
        });
        this.busy = false;
        if (response?.state) musicPlayer.applySharedState(response.state);
        if (!response?.ok) {
            await this.refresh();
            this.setStatus(response?.result?.result?.reason || '队列已变化，请重新选择', 'error');
            return;
        }
        this.setStatus(response.result?.result?.moved === false ? '该歌曲已经是下一首' : '已设为下一首', 'success');
    }

    async remove(orderId) {
        const order = this.orders.get(orderId);
        if (!order || orderId === this.currentOrderId) return;
        const songName = order.song?.sname || '这首歌曲';
        if (!window.confirm(`确定删除待播歌曲“${songName}”吗？`)) return;
        this.busy = true;
        this.render(this.orders.get(this.currentOrderId));
        this.setStatus('正在删除歌曲…', 'loading');
        const response = await musicPlayer.sendCommand('removeOrder', {
            orderId,
            expectedQueueRevision: this.queueRevision,
            expectedCurrentOrderId: this.currentOrderId
        });
        this.busy = false;
        if (response?.state) musicPlayer.applySharedState(response.state);
        if (!response?.ok) {
            await this.refresh();
            this.setStatus(response?.result?.result?.reason || '队列已变化，请重新选择', 'error');
            return;
        }
        this.setStatus(response.result?.result?.removed === true ? '歌曲已删除' : '歌曲未删除', 'success');
    }

    async saveOrder() {
        if (this.busy || !this.isDraftDirty()) return;
        this.busy = true;
        this.render(this.orders.get(this.currentOrderId));
        this.setStatus('正在保存顺序…', 'loading');
        const response = await musicPlayer.sendCommand('reorderQueue', {
            expectedQueueRevision: this.queueRevision,
            expectedCurrentOrderId: this.currentOrderId,
            pendingOrderIds: this.draftOrderIds.slice()
        });
        this.busy = false;
        if (response?.state) musicPlayer.applySharedState(response.state);
        if (!response?.ok) {
            await this.refresh();
            this.setStatus('队列已变化，请重新确认排序', 'error');
            return;
        }
        this.setStatus('队列顺序已保存', 'success');
    }

    cancelDraft() {
        this.draftOrderIds = this.originalOrderIds.slice();
        this.render(this.orders.get(this.currentOrderId));
        this.setStatus('已撤销未保存的排序');
    }

    async refresh() {
        await musicPlayer.requestSharedState();
    }
}

export default new QueueManager();
