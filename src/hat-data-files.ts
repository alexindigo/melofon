import { createImageFiles } from './image-files.ts';

export function createHatDataFiles(dataDir: string) {
  return createImageFiles(dataDir, 'hat-images', 'hat image');
}
