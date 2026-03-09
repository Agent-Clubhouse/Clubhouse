declare module 'picomatch' {
  interface PicomatchOptions {
    dot?: boolean;
    nocase?: boolean;
  }

  type Matcher = (input: string) => boolean;

  export default function picomatch(pattern: string | readonly string[], options?: PicomatchOptions): Matcher;
}
