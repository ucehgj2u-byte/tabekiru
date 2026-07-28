/** wrangler.toml の Text ルールで取り込む .html を文字列として型付けする。 */
declare module '*.html' {
  const content: string;
  export default content;
}
