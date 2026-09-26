declare module 'heic-convert' {
  export default function convert(options: { buffer: Buffer | ArrayBufferLike; format: 'JPEG' | 'PNG'; quality?: number }): Promise<ArrayBuffer>;
}
