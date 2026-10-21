// use host modules directly; packaged plugins cannot rely on jsx transforms or local runtime copies.
declare module "opentui:runtime-module:solid-js" {
  export * from "solid-js";
}

declare module "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime" {
  export * from "@opentui/solid/jsx-runtime";
}
