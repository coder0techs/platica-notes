// Open the first-run welcome page only on a genuine install — never on an update
// or a browser/extension restart. Existing users (and their saved default caption
// language) are left untouched, mirroring the default-language migration rule.
export function shouldOpenWelcome(reason: string): boolean {
  return reason === "install"
}
