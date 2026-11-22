// Redis pub/sub channels and capped-history list keys. Both tracks publish
// here, so these names are a contract: renaming one breaks the other track.
export const FRAME_CHANNEL = 'frames';
export const TCP_CHANNEL = 'tcp';
export const TCP_STATE_CHANNEL = 'tcp-state';
export const RTT_CHANNEL = 'rtt';

export const FRAME_HISTORY_KEY = 'frames';
export const TCP_HISTORY_KEY = 'tcp';
export const TCP_STATE_HISTORY_KEY = 'tcp-state';
export const RTT_HISTORY_KEY = 'rtt';

export const DEFAULT_HISTORY_LIMIT = 10_000;
