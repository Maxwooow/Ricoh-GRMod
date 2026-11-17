

export const isPreset = (f: File): boolean => /\.(xmp|cube)$/i.test(f.name);
export const isFirmware = (f: File): boolean => /\.bin$/i.test(f.name);
export const isImage = (f: File): boolean => /^image\//.test(f.type) || /\.(jpe?g|png|webp|bmp|gif|avif|heic|heif)$/i.test(f.name);
