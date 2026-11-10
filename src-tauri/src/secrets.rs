//! Secret storage behind `secret_get` / `secret_set`.
//!
//! Desktop: the OS keychain via `keyring`. Android: a JSON map in the
//! app-private data directory, which only this app's sandbox user can read
//! (no keyring backend exists there; Android Keystore needs a JVM plugin).

pub use imp::Secrets;

#[cfg(not(target_os = "android"))]
mod imp {
    use super::super::err;

    const KEYRING_SERVICE: &str = "dev.rayla.player";

    pub struct Secrets;

    impl Secrets {
        pub fn new(_data_dir: Option<std::path::PathBuf>) -> Self {
            Secrets
        }

        fn entry(key: &str) -> Result<keyring::Entry, String> {
            keyring::Entry::new(KEYRING_SERVICE, key).map_err(err)
        }

        pub fn get(&self, key: &str) -> Result<Option<String>, String> {
            match Self::entry(key)?.get_password() {
                Ok(v) => Ok(Some(v)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(err(e)),
            }
        }

        pub fn set(&self, key: &str, value: Option<String>) -> Result<(), String> {
            let e = Self::entry(key)?;
            match value {
                Some(v) => e.set_password(&v).map_err(err),
                None => match e.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(e) => Err(err(e)),
                },
            }
        }
    }
}

#[cfg(target_os = "android")]
mod imp {
    use super::super::err;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    pub struct Secrets {
        path: Option<PathBuf>,
        lock: Mutex<()>,
    }

    impl Secrets {
        pub fn new(data_dir: Option<PathBuf>) -> Self {
            Secrets { path: data_dir.map(|d| d.join("secrets.json")), lock: Mutex::new(()) }
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
            // Write-then-rename so a crash never leaves a truncated file.
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec(&map).map_err(err)?).map_err(err)?;
            std::fs::rename(&tmp, path).map_err(err)
        }
    }
}
