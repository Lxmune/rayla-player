//! Secret storage behind `secret_get` / `secret_set`.
//!
//! - Windows / macOS: the OS keychain via `keyring`.
//! - Linux: the Secret Service (GNOME Keyring, KWallet) via `keyring`. When no Secret
//!   Service is reachable (bare window managers, some sandboxes), a JSON file in the app
//!   data directory readable only by the user (mode 0600).
//! - Android: that same JSON file in the app-private data directory, which only this
//!   app's sandbox user can read (no keyring backend exists there; Android Keystore
//!   needs a JVM plugin).

use super::err;
use std::path::PathBuf;

pub enum Secrets {
    #[cfg(not(target_os = "android"))]
    Keychain,
    #[cfg(any(target_os = "android", target_os = "linux"))]
    File(file::FileStore),
}

impl Secrets {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        #[cfg(target_os = "android")]
        return Secrets::File(file::FileStore::new(data_dir));

        #[cfg(target_os = "linux")]
        return match keychain::available() {
            Ok(()) => Secrets::Keychain,
            Err(e) => {
                eprintln!("Secret Service unavailable ({e}); storing secrets in a private file");
                Secrets::File(file::FileStore::new(data_dir))
            }
        };

        #[cfg(not(any(target_os = "android", target_os = "linux")))]
        {
            let _ = data_dir;
            Secrets::Keychain
        }
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        match self {
            #[cfg(not(target_os = "android"))]
            Secrets::Keychain => keychain::get(key),
            #[cfg(any(target_os = "android", target_os = "linux"))]
            Secrets::File(f) => f.get(key),
        }
    }

    pub fn set(&self, key: &str, value: Option<String>) -> Result<(), String> {
        match self {
            #[cfg(not(target_os = "android"))]
            Secrets::Keychain => keychain::set(key, value),
            #[cfg(any(target_os = "android", target_os = "linux"))]
            Secrets::File(f) => f.set(key, value),
        }
    }
}

#[cfg(not(target_os = "android"))]
mod keychain {
    use super::err;

    const SERVICE: &str = "dev.rayla.player";

    fn entry(key: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, key).map_err(err)
    }

    /// Whether the store answers at all: a lookup of a key that is never written must
    /// come back as "no entry" rather than a connection or platform error.
    #[cfg(target_os = "linux")]
    pub fn available() -> Result<(), keyring::Error> {
        match keyring::Entry::new(SERVICE, "__probe__")?.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn get(key: &str) -> Result<Option<String>, String> {
        match entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(err(e)),
        }
    }

    pub fn set(key: &str, value: Option<String>) -> Result<(), String> {
        let e = entry(key)?;
        match value {
            Some(v) => e.set_password(&v).map_err(err),
            None => match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(err(e)),
            },
        }
    }
}

#[cfg(any(target_os = "android", target_os = "linux"))]
mod file {
    use super::err;
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::PathBuf;
    use std::sync::Mutex;

    pub struct FileStore {
        path: Option<PathBuf>,
        lock: Mutex<()>,
    }

    impl FileStore {
        pub fn new(data_dir: Option<PathBuf>) -> Self {
            FileStore { path: data_dir.map(|d| d.join("secrets.json")), lock: Mutex::new(()) }
        }

        fn path(&self) -> Result<&PathBuf, String> {
            self.path.as_ref().ok_or_else(|| "app data directory unavailable".to_string())
        }

        fn load(&self) -> Result<BTreeMap<String, String>, String> {
            match std::fs::read(self.path()?) {
                Ok(bytes) => serde_json::from_slice(&bytes).map_err(err),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
                Err(e) => Err(err(e)),
            }
        }

        pub fn get(&self, key: &str) -> Result<Option<String>, String> {
            let _g = self.lock.lock().unwrap();
            Ok(self.load()?.remove(key))
        }

        pub fn set(&self, key: &str, value: Option<String>) -> Result<(), String> {
            let _g = self.lock.lock().unwrap();
            let mut map = self.load()?;
            match value {
                Some(v) => map.insert(key.to_string(), v),
                None => map.remove(key),
            };
            let path = self.path()?;
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(err)?;
            }
            // Write-then-rename so a crash never leaves a truncated file. The temp file is
            // created owner-only, so the secrets are never readable by other users.
            let tmp = path.with_extension("json.tmp");
            // A leftover from a crash could carry other permissions; `mode` only applies on create.
            let _ = std::fs::remove_file(&tmp);
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp)
                .map_err(err)?;
            f.write_all(&serde_json::to_vec(&map).map_err(err)?).map_err(err)?;
            f.sync_all().map_err(err)?;
            drop(f);
            std::fs::rename(&tmp, path).map_err(err)
        }
    }
}
