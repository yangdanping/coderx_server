interface UploadMetadata {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface DiskUpload extends UploadMetadata {
  kind: 'disk';
  filename: string;
  destination: string;
  path: string;
}

export interface MemoryUpload extends UploadMetadata {
  kind: 'memory';
  fieldname: 'image';
  encoding: string;
  buffer: Buffer;
}
