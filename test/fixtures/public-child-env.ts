/** Public package/fixture processes receive no inherited authentication or secret settings. */
export function publicChildEnv(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !/token|secret|password|credential|api_?key|private_?key|npm_media_server|(?:^|_)auth(?:_|$)/i.test(key)));
}
