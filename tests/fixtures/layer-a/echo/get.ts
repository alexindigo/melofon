// Test fixture: a real endpoint so facade dispatch into a layer is provable
// (an empty tree is not representable — pathfinder rejects zero-file roots).
export default () => ({ layer: 'a', route: '/echo' });
