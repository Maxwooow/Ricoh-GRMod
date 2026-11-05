// Power-off image rotation: generator for the camera's start-up script and a
// simulator of the script language subset for testing it.

export { rotationScript, rotationScriptInfo, imageFileName, MODEL_INFO, MODEL_FILE, MODEL_FILE_MAGIC, CARD_FILES, MAX_IMAGES } from './script';
export type { CameraModel, WallpaperModel } from './script';

export { runScript } from './sim';
export type { SimFs, SimOptions, SimResult } from './sim';
