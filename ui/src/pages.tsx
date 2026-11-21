/**
 * The pages of the app. Each is in pages/; this file gathers what app.tsx shows.
 *
 *   image-control  the Image Control page (slots and menu order), built from:
 *     preview        the before / after preview of a preset
 *     slot-cards     the cards of the factory and added slots, halation
 *     look-order     the menu order list with drag and drop
 *     features       the switches of the firmware additions
 *   ratio          added aspect ratios
 *   grid           custom grid lines (GR IV)
 *   wallpaper      power-off pictures
 *   crop           the crop editor of a power-off picture
 *   files          what kind of file was dropped
 */
export * from './pages/files';
export * from './pages/preview';
export * from './pages/slot-cards';
export * from './pages/look-order';
export * from './pages/features';
export * from './pages/image-control';
export * from './pages/ratio';
export * from './pages/grid';
export * from './pages/wallpaper';
export * from './pages/crop';
