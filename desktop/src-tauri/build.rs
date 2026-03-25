fn main() {
    // Force Cargo to recompile when the embedded web frontend changes.
    // rust_embed uses include_bytes!() at compile time (release mode),
    // but Cargo doesn't automatically track those external files.
    // We track individual files in dist/ so any rebuild triggers recompilation.
    let dist = std::path::Path::new("../../frontend/dist");
    if dist.exists() {
        for entry in std::fs::read_dir(dist).into_iter().flatten().flatten() {
            println!("cargo:rerun-if-changed={}", entry.path().display());
        }
        // Also track the assets subdirectory
        let assets = dist.join("assets");
        if assets.exists() {
            for entry in std::fs::read_dir(&assets).into_iter().flatten().flatten() {
                println!("cargo:rerun-if-changed={}", entry.path().display());
            }
        }
    }
    println!("cargo:rerun-if-changed=../../frontend/dist/");

    tauri_build::build()
}
