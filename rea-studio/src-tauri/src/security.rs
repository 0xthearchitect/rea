use crate::models::{Error, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
};
pub const MAX_BUNDLE: u64 = 64 * 1024 * 1024;
pub fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    if file.metadata()?.len() > limit {
        return Err(Error::new(
            "resource_constraint",
            format!(
                "File exceeds the {} byte limit; original remains at {}",
                limit,
                path.display()
            ),
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(Error::new(
            "resource_constraint",
            "File grew beyond its read limit",
        ));
    }
    Ok(bytes)
}
pub fn source_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains('\\')
        || relative.contains(':')
        || relative.contains('\0')
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || relative
            .split('/')
            .any(|s| s == "." || s == ".." || s.is_empty())
    {
        return Err(Error::new(
            "invalid_path",
            "Source path must be an exact relative artifact path without traversal",
        ));
    }
    let canonical_root = root.canonicalize()?;
    let resolved = canonical_root.join(path).canonicalize()?;
    if !resolved.starts_with(&canonical_root) {
        return Err(Error::new(
            "invalid_path",
            "Source escapes the imported directory",
        ));
    }
    Ok(resolved)
}
pub fn verified_source(root: &Path, relative: &str, digest: &str) -> Result<String> {
    if !root.is_dir() {
        return Err(Error::new("unsupported", "ASAR source bytes are retained in Evidence; direct source inspection requires a directory target"));
    }
    let bytes = read_bounded(&source_path(root, relative)?, 2 * 1024 * 1024)?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != digest {
        return Err(Error::new(
            "target_changed",
            "Current source bytes differ from the analysis artifact digest. Run a new analysis.",
        ));
    }
    String::from_utf8(bytes).map_err(|e| Error::new("invalid_encoding", e.to_string()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_and_preserves_identity() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.js"), b"export const x = 1;").unwrap();
        for p in [
            "../x.js",
            "/x.js",
            "a/../x.js",
            "C:/x.js",
            "a\\x.js",
            "./x.js",
        ] {
            assert!(source_path(dir.path(), p).is_err(), "{p}");
        }
        let hash = format!("{:x}", Sha256::digest(b"export const x = 1;"));
        assert!(verified_source(dir.path(), "x.js", &hash).is_ok());
        assert_eq!(
            verified_source(dir.path(), "x.js", &"0".repeat(64))
                .unwrap_err()
                .code,
            "target_changed"
        );
    }
    #[test]
    fn bounded_reads_fail_without_truncating() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("raw");
        std::fs::write(&p, b"1234").unwrap();
        assert!(read_bounded(&p, 3).is_err());
        assert_eq!(read_bounded(&p, 4).unwrap(), b"1234");
    }
}
