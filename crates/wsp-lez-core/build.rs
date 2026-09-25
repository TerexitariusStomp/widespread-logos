fn main() {
    // The MinGW-w64 rapidsnark archive is built against the mman-win32 mmap
    // shim; libmman.a ships inside the archive's lib/ directory, which
    // rust-rapidsnark's build script already places on the link search path.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=static=mman");
    }
}
