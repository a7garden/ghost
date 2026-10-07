//! Owner-managed Codex pet sprites. Metadata is polled; pixels are fetched on demand.
use super::{now_ms, State};
use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageFormat, ImageReader};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Cursor;

pub const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const FRAMES: [u32; 11] = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AvatarInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub sprite_version: u8,
    pub data_url: String,
    pub design: Option<Value>,
    #[serde(default)]
    pub source_manifest: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Avatar {
    pub id: String,
    pub name: String,
    pub description: String,
    pub sprite_version: u8,
    pub design: Option<Value>,
    #[serde(default)]
    pub source_manifest: Option<Value>,
    pub created_ms: u64,
}
#[derive(Default, Clone, Debug, Serialize, Deserialize)]
pub struct Assignment {
    pub avatar_id: Option<String>,
    pub version: u64,
}

pub fn validate(input: &AvatarInput) -> Result<()> {
    if input.name.trim().is_empty() || input.name.len() > 240 || input.description.len() > 3000 {
        bail!("아바타 이름 또는 설명의 길이를 확인해 주세요.");
    }
    if !matches!(input.sprite_version, 1 | 2) {
        bail!("Codex 펫 v1 또는 v2만 지원합니다.");
    }
    if input
        .design
        .as_ref()
        .is_some_and(|v| !v.is_object() || v.to_string().len() > 4096)
    {
        bail!("아바타 디자인 정보가 올바르지 않습니다.");
    }
    if let Some(manifest) = &input.source_manifest {
        if manifest
            .get("spriteVersionNumber")
            .is_some_and(|v| !matches!(v.as_u64(), Some(1 | 2)))
        {
            bail!("Codex 펫 v1 또는 v2 버전을 확인해 주세요.");
        }
        let sprite = manifest
            .get("spritesheetPath")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !manifest.is_object()
            || manifest.to_string().len() > 8192
            || manifest
                .get("spriteVersionNumber")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                != u64::from(input.sprite_version)
            || manifest
                .get("displayName")
                .and_then(Value::as_str)
                .is_none()
            || sprite.is_empty()
            || std::path::Path::new(sprite).is_absolute()
            || sprite.split(['/', '\\']).any(|p| p == "..")
        {
            bail!("Codex pet.json의 버전, 이름 또는 이미지 경로를 확인해 주세요.");
        }
    }
    let (encoded, format) = if let Some(s) = input.data_url.strip_prefix("data:image/png;base64,") {
        (s, ImageFormat::Png)
    } else if let Some(s) = input.data_url.strip_prefix("data:image/webp;base64,") {
        (s, ImageFormat::WebP)
    } else {
        bail!("PNG 또는 WebP 스프라이트를 선택해 주세요.");
    };
    if encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        bail!("이미지는 4 MiB 이하여야 합니다.");
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| anyhow!("이미지 데이터를 읽을 수 없습니다."))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        bail!("이미지는 4 MiB 이하여야 합니다.");
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(1536);
    limits.max_image_height = Some(2288);
    limits.max_alloc = Some(48 * 1024 * 1024);
    reader.limits(limits);
    let rgba = reader
        .decode()
        .map_err(|_| anyhow!("이미지 형식 또는 크기가 올바르지 않습니다."))?
        .into_rgba8();
    let rows = if input.sprite_version == 2 { 11 } else { 9 };
    if rgba.dimensions() != (1536, rows * 208) {
        bail!(
            "펫 v{} 크기는 1536 × {}이어야 합니다.",
            input.sprite_version,
            rows * 208
        );
    }
    // Codex's loader requires the atlas dimensions, not blank unused cells.
    // Real installed pets may contain extra pixels there. Preserve them verbatim
    // instead of applying Ghost's creation-quality gate to imported characters.
    if input.source_manifest.is_some() {
        return Ok(());
    }
    for row in 0..rows {
        for col in 0..8 {
            let mut visible = 0;
            let mut transparent = 0;
            for y in row * 208..(row + 1) * 208 {
                for x in col * 192..(col + 1) * 192 {
                    let alpha = rgba.get_pixel(x, y).0[3];
                    if alpha > 0 {
                        visible += 1;
                    }
                    if alpha == 0 {
                        transparent += 1;
                    }
                }
            }
            if col < FRAMES[row as usize] {
                if visible < 32 {
                    bail!("{}행 {}번째 동작에 그림이 없습니다.", row + 1, col + 1);
                }
                if transparent < 192 * 208 / 5 {
                    bail!(
                        "{}행 {}번째 동작의 배경을 투명하게 해 주세요.",
                        row + 1,
                        col + 1
                    );
                }
            } else if visible != 0 {
                bail!("{}행 {}번째 빈 칸에 그림이 있습니다.", row + 1, col + 1);
            }
        }
    }
    Ok(())
}

pub(super) fn create(s: &State, id: &str, input: AvatarInput) -> Result<Value> {
    if s.journal.objects::<Avatar>("avatar")?.len() >= 64 {
        bail!("아바타는 최대 64개까지 보관할 수 있습니다.");
    }
    validate(&input)?;
    let avatar = Avatar {
        id: id.into(),
        name: input.name.trim().into(),
        description: input.description.trim().into(),
        sprite_version: input.sprite_version,
        design: input.design,
        source_manifest: input.source_manifest,
        created_ms: now_ms(),
    };
    let tx = s.journal.0.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO workspace_objects(kind,id,payload) VALUES('avatar',?,?)",
        params![id, serde_json::to_string(&avatar)?],
    )?;
    tx.execute(
        "INSERT INTO workspace_objects(kind,id,payload) VALUES('avatar_image',?,?)",
        params![id, serde_json::to_string(&input.data_url)?],
    )?;
    tx.commit()?;
    Ok(json!(avatar))
}
pub(super) fn read(s: &State, id: &str) -> Result<Value> {
    let avatar = s
        .journal
        .get::<Avatar>("avatar", id)?
        .ok_or_else(|| anyhow!("아바타를 찾을 수 없습니다."))?;
    let data_url = s
        .journal
        .get::<String>("avatar_image", id)?
        .ok_or_else(|| anyhow!("아바타 이미지가 없습니다."))?;
    Ok(json!({"avatar": avatar, "data_url": data_url}))
}
pub(super) fn assign(
    s: &State,
    profile: &str,
    avatar_id: Option<String>,
    version: u64,
) -> Result<Value> {
    if !s.profiles.contains_key(profile) {
        bail!("Ghost를 찾을 수 없습니다.");
    }
    if let Some(id) = &avatar_id {
        if s.journal.get::<Avatar>("avatar", id)?.is_none() {
            bail!("아바타를 찾을 수 없습니다.");
        }
    }
    let old = s
        .journal
        .get::<Assignment>("profile_avatar", profile)?
        .unwrap_or_default();
    if old.version != version {
        bail!("다른 곳에서 아바타를 변경했습니다. 최신 화면에서 다시 선택해 주세요.");
    }
    let result = Assignment {
        avatar_id,
        version: version + 1,
    };
    s.journal.put("profile_avatar", profile, &result)?;
    Ok(json!(result))
}
pub(super) fn delete(s: &State, id: &str) -> Result<Value> {
    if s.journal
        .objects::<Assignment>("profile_avatar")?
        .iter()
        .any(|a| a.avatar_id.as_deref() == Some(id))
    {
        bail!("사용 중인 아바타입니다. Ghost의 아바타를 먼저 변경해 주세요.");
    }
    if s.journal.get::<Avatar>("avatar", id)?.is_none() {
        bail!("아바타를 찾을 수 없습니다.");
    }
    let tx = s.journal.0.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM workspace_objects WHERE kind IN ('avatar','avatar_image') AND id=?",
        [id],
    )?;
    tx.commit()?;
    Ok(json!({"deleted": id}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        control::api::{Action, Command, OwnerAction},
        host::Host,
        store::ProfileStore,
    };
    fn fixture(version: u8, change: impl FnOnce(&mut image::RgbaImage)) -> AvatarInput {
        let rows = if version == 2 { 11 } else { 9 };
        let mut pixels = image::RgbaImage::new(1536, rows * 208);
        for row in 0..rows {
            for col in 0..FRAMES[row as usize] {
                for y in 80..112 {
                    for x in 80..112 {
                        pixels.put_pixel(
                            col * 192 + x,
                            row * 208 + y,
                            image::Rgba([120, 150, 200, 255]),
                        );
                    }
                }
            }
        }
        change(&mut pixels);
        let mut bytes = Cursor::new(Vec::new());
        pixels.write_to(&mut bytes, ImageFormat::Png).unwrap();
        AvatarInput {
            name: "Mint".into(),
            description: "Fixture".into(),
            sprite_version: version,
            data_url: format!(
                "data:image/png;base64,{}",
                STANDARD.encode(bytes.into_inner())
            ),
            design: None,
            source_manifest: None,
        }
    }
    #[test]
    fn validates_both_versions_and_rejects_blank_opaque_unused_and_corrupt_images() {
        assert!(validate(&fixture(1, |_| {})).is_ok());
        assert!(validate(&fixture(2, |_| {})).is_ok());
        let mut imported = fixture(1, |p| p.put_pixel(7 * 192, 0, image::Rgba([1, 2, 3, 255])));
        imported.source_manifest =
            Some(json!({"displayName":"Legacy Codex","spritesheetPath":"spritesheet.png"}));
        assert!(validate(&imported).is_ok());
        imported.sprite_version = 2;
        assert!(validate(&imported).is_err());
        assert!(validate(&fixture(2, |p| {
            for y in 0..208 {
                for x in 0..192 {
                    p.put_pixel(x, y, image::Rgba([0, 0, 0, 0]));
                }
            }
        }))
        .is_err());
        assert!(validate(&fixture(2, |p| {
            for y in 0..208 {
                for x in 0..192 {
                    p.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
                }
            }
        }))
        .is_err());
        assert!(validate(&fixture(2, |p| p.put_pixel(
            7 * 192,
            0,
            image::Rgba([1, 2, 3, 1])
        )))
        .is_err());
        let mut input = fixture(1, |_| {});
        input.sprite_version = 2;
        assert!(validate(&input).is_err());
        input.data_url = "data:image/png;base64,aW52YWxpZA==".into();
        assert!(validate(&input).is_err());
        input.data_url = "data:image/svg+xml;base64,aW52YWxpZA==".into();
        assert!(validate(&input).is_err());
    }
    fn command(app: &std::sync::Arc<Host>, action: OwnerAction) -> Value {
        app.action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Workspace { action },
        })
        .unwrap()
    }
    #[tokio::test]
    async fn avatars_persist_isolate_profiles_and_enforce_conflicts_and_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let first = ProfileStore::create_profile(dir.path(), "first", "")
            .unwrap()
            .uuid;
        let second = ProfileStore::create_profile(dir.path(), "second", "")
            .unwrap()
            .uuid;
        let app = Host::open(dir.path(), tokio::runtime::Handle::current(), None).unwrap();
        let manifest = json!({"id":"original-pet", "displayName":"Original", "description":"Unchanged metadata",
            "spriteVersionNumber":2,"spritesheetPath":"spritesheet.webp","custom_field":{"preserve":true}});
        let mut input = fixture(2, |_| {});
        input.source_manifest = Some(manifest.clone());
        let original_pixels = input.data_url.clone();
        let create = Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Workspace {
                action: OwnerAction::CreateAvatar { avatar: input },
            },
        };
        let replay = serde_json::from_value(serde_json::to_value(&create).unwrap()).unwrap();
        let created = app.action(create).unwrap();
        assert_eq!(created["ok"], true);
        let id = created["result"]["id"].as_str().unwrap().to_string();
        assert_eq!(app.action(replay).unwrap(), created);
        assert_eq!(
            command(
                &app,
                OwnerAction::SetProfileAvatar {
                    profile_id: first.clone(),
                    avatar_id: Some(id.clone()),
                    version: 0
                }
            )["ok"],
            true
        );
        assert_eq!(
            command(
                &app,
                OwnerAction::SetProfileAvatar {
                    profile_id: first.clone(),
                    avatar_id: None,
                    version: 0
                }
            )["ok"],
            false
        );
        let snapshot = app.snapshot().unwrap();
        let profiles = snapshot["profiles"].as_array().unwrap();
        assert_eq!(
            profiles.iter().find(|p| p["id"] == first).unwrap()["avatar_id"],
            id
        );
        assert!(profiles.iter().find(|p| p["id"] == second).unwrap()["avatar_id"].is_null());
        assert!(!snapshot.to_string().contains("data:image"));
        assert_eq!(snapshot["avatars"].as_array().unwrap().len(), 1);
        let before: u64 = app
            .lock()
            .unwrap()
            .journal
            .0
            .query_row("SELECT count(*) FROM workspace_commands", [], |r| r.get(0))
            .unwrap();
        assert!(
            command(&app, OwnerAction::ReadAvatar { id: id.clone() })["result"]["data_url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png")
        );
        assert_eq!(
            app.lock()
                .unwrap()
                .journal
                .0
                .query_row("SELECT count(*) FROM workspace_commands", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            before
        );
        assert_eq!(
            command(&app, OwnerAction::DeleteAvatar { id: id.clone() })["ok"],
            false
        );
        app.shutdown().await.unwrap();
        drop(app);
        let app = Host::open(dir.path(), tokio::runtime::Handle::current(), None).unwrap();
        assert_eq!(app.snapshot().unwrap()["avatars"][0]["id"], id);
        let restored = command(&app, OwnerAction::ReadAvatar { id: id.clone() });
        assert_eq!(restored["result"]["avatar"]["source_manifest"], manifest);
        assert_eq!(restored["result"]["data_url"], original_pixels);
        assert_eq!(
            command(
                &app,
                OwnerAction::SetProfileAvatar {
                    profile_id: first,
                    avatar_id: None,
                    version: 1
                }
            )["ok"],
            true
        );
        assert_eq!(
            command(&app, OwnerAction::DeleteAvatar { id: id.clone() })["ok"],
            true
        );
        assert_eq!(command(&app, OwnerAction::ReadAvatar { id })["ok"], false);
        app.shutdown().await.unwrap();
    }
}
