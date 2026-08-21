/// <reference types="vite/client" />

declare module 'whisper.cpp' {
  const whisperFactory: (options?: Record<string, unknown>) => Promise<any>;
  export default whisperFactory;
}
