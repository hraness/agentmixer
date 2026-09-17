use crate::{Error, Result, digest, private};
use image::{GenericImageView, ImageFormat, ImageReader, Limits};
use std::{
    fs::OpenOptions,
    io::{Cursor, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
use xcb_core::session::Attachment;

const MAX_BYTES: usize = 10 * 1024 * 1024;

fn inspect(bytes: &[u8]) -> Result<Attachment> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(xcb_core::Error::Limit("image bytes").into());
    }
    let format =
        image::guess_format(bytes).map_err(|_| xcb_core::Error::Invalid("image format"))?;
    let media_type = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        _ => return Err(xcb_core::Error::Invalid("supported image format").into()),
    };
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| xcb_core::Error::Invalid("image data or dimensions"))?;
    let (width, height) = decoded.dimensions();
    let attachment = Attachment {
        digest: digest(bytes),
        media_type: media_type.into(),
        bytes: bytes.len() as u64,
        width,
        height,
    };
    attachment.validate()?;
    Ok(attachment)
}

pub fn store(root: &Path, bytes: &[u8]) -> Result<Attachment> {
    let attachment = inspect(bytes)?;
    let path = root.join("attachments").join(&attachment.digest);
    match private::read(&path, MAX_BYTES) {
        Ok(existing) if digest(&existing) == attachment.digest => (),
        Ok(_) => return Err(Error::Conflict("stored image integrity")),
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            private::create(&path, bytes)?
        }
        Err(error) => return Err(error),
    }
    Ok(attachment)
}

pub fn from_path(root: &Path, path: &Path) -> Result<Attachment> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.nlink() != 1 || meta.len() > MAX_BYTES as u64 {
        return Err(xcb_core::Error::Invalid("image file").into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    store(root, &bytes)
}

pub fn from_rgba(root: &Path, width: usize, height: usize, bytes: Vec<u8>) -> Result<Attachment> {
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || width
            .checked_mul(height)
            .is_none_or(|pixels| pixels > 16_000_000)
        || width
            .checked_mul(height)
            .and_then(|pixels| pixels.checked_mul(4))
            != Some(bytes.len())
    {
        return Err(xcb_core::Error::Invalid("clipboard image dimensions").into());
    }
    let image = image::RgbaImage::from_raw(width as u32, height as u32, bytes)
        .ok_or(xcb_core::Error::Invalid("clipboard image"))?;
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| xcb_core::Error::Invalid("clipboard image encoding"))?;
    store(root, output.get_ref())
}

pub fn read(root: &Path, attachment: &Attachment) -> Result<Vec<u8>> {
    attachment.validate()?;
    let bytes = private::read(
        &root.join("attachments").join(&attachment.digest),
        MAX_BYTES,
    )?;
    if bytes.len() as u64 != attachment.bytes || digest(&bytes) != attachment.digest {
        return Err(Error::Conflict("attachment changed"));
    }
    Ok(bytes)
}
