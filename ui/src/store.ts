/**
 * The UI's state and everything that changes it. The parts are in store/: this file only gathers them, so
 * the rest of the UI imports from './store' as before.
 *
 *   core      the state itself, set / useStore, toasts and confirmations
 *   families  GR IV and GR III / IIIx work kept apart, and saving the project
 *   settings  guided tours, page, model, language, opening firmware
 *   slots     presets, names, icons and halation of the Image Control slots
 *   looks     the Image Control menu's order and hidden looks
 *   wall      power-off pictures
 *   features  soft focus, date imprint, monochrome looks and the other switches
 *   framing   the framing guides of GR IV 1.20 / 1.21 (the custom grid's page)
 *   ratios    added aspect ratios
 *   photo     the preview photo
 *   output    memory cards, building and writing firmware
 *   copies    firmware copies on the card and their backups
 */
export * from './store/core';
export * from './store/families';
export * from './store/settings';
export * from './store/slots';
export * from './store/looks';
export * from './store/wall';
export * from './store/features';
export * from './store/framing';
export * from './store/ratios';
export * from './store/photo';
export * from './store/output';
export * from './store/copies';
