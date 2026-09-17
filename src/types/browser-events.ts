import type { RoomState } from './sync.js';

export interface BrowserEventDetailMap {
  'damuku-room-state': RoomState;
}

declare global {
  interface Window {
    API_CONFIG?: {
      BASE_PATH?: string;
      bili_api?: string;
      netease_api?: string;
      qqmusic_api?: string;
    };
    __DAMUKU_PRODUCT_VERSION?: string;
    __DAMUKU_FRONTEND_BUILD_ID?: string;
  }

  interface WindowEventMap {
    'damuku-room-state': CustomEvent<BrowserEventDetailMap['damuku-room-state']>;
  }
}

export {};
