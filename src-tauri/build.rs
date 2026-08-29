fn main() {
    // tauri-build 遍历 binaries/ 资源目录（含 dsh-runtime 数万文件）时，
    // Windows 默认 1MB 主线程栈会导致栈溢出（STATUS_STACK_OVERFLOW）。
    // 放到大栈线程中执行，规避该问题（macOS/Linux 不受影响，同样适用）。
    let builder = std::thread::Builder::new()
        .name("tauri-build".into())
        .stack_size(64 * 1024 * 1024);
    builder
        .spawn(|| tauri_build::build())
        .expect("spawn tauri-build thread")
        .join()
        .expect("tauri-build failed");
}
