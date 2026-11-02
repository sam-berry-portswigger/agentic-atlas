export function readNDJSON(
  stream: ReadableStream<Uint8Array>,
  receive: (message: any) => void,
): Promise<void>;
export function partialJSONString(text: string, field?: string): string;
export function partialJSONArray(text: string, field?: string): any[];
