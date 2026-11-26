// Pure policy shared by both HTTP entry points.
export function buildAllowedOrigins(redirectURL: string): string[] {
  return ['http://95.40.29.75:8080', 'https://coderx.my', 'https://api.ydp321.asia', redirectURL];
}
