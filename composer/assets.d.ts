declare module "*.css" {
  const text: string;
  export default text;
}

declare module "composer-speed-ranks" {
  const ranks: ConstructorParameters<typeof import("js-tiktoken/lite").Tiktoken>[0];
  export default ranks;
}
