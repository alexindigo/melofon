// Test fixture: claims two ports to prove the positional remap of
// MELOFON_LISTEN_<layer> (HTTP 3689 + WS 3688 in the real OwnTone shape; M5
// does not serve WS, a plain GET endpoint is enough here).
export default () => ({ layer: 'two', route: '/ws-hook' });
