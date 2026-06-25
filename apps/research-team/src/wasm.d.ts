// Workers 把静态 import 的 .wasm 解析为预编译的 WebAssembly.Module。
declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
