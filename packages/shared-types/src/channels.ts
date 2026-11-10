// Redis pub/sub channels and capped-history list keys. Both tracks publish
// here, so these names are a contract: renaming one breaks the other track.
export const FRAME_CHANNEL = 'frames';
export const TCP_CHANNEL = 'tcp';

export const FRAME_HISTORY_KEY = 'frames';
export const TCP_HISTORY_KEY = 'tcp';

export const DEFAULT_HISTORY_LIMIT = 10_000;
