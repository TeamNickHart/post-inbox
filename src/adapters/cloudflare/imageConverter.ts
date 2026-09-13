import type { ConvertedImage, ImageConverter } from '../../core/imageConversion.ts'

/**
 * HEIC to JPEG, using the Cloudflare Images binding.
 *
 * The only file that knows Cloudflare Images exists. Everything about *whether*
 * to convert lives in `core/imageConversion.ts`; this just performs one.
 *
 * Verified against the live binding with a real iPhone HEIC before being
 * written, because the whole approach rested on it:
 *
 * - HEIC decodes: `info()` reports `image/heic`, and the output is a valid JPEG
 *   at the source dimensions.
 * - **EXIF is stripped entirely.** A source carrying 2,934 bytes of EXIF came
 *   back with only an `APP0/JFIF` segment — no APP1, so no GPS. The pipeline
 *   still runs `stripImageMetadata` afterwards as defence in depth, but the
 *   binding satisfies the requirement on its own.
 * - **Rotation is baked into pixels.** A 400x200 image tagged `Orientation=6`
 *   came back 200x400 with no orientation tag, so a portrait photo is upright
 *   without depending on a tag surviving. This is the failure mode that would
 *   otherwise render every portrait photo sideways.
 * - Colour survives: channel means within ~1.6/255 of a libheif reference
 *   decode, despite the ICC profile being dropped.
 *
 * Note the binding exposes no `metadata` option — that exists on the URL-based
 * transform API but not in `ImageTransform` — which is why stripping is not
 * configured here and the guarantee rests on the observations above.
 */

/**
 * JPEG quality for converted images.
 *
 * 82 is the usual "indistinguishable at normal viewing" point. The committed
 * file is a source for `next/image`, which re-encodes for delivery anyway, so
 * this only needs to avoid throwing away detail the site might later want.
 */
const JPEG_QUALITY = 82

/** Cloudflare's limit for `.input()`. Bigger cannot be attempted. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024

/** Cloudflare's limit, expressed as pixels rather than megapixels. */
const MAX_PIXELS = 100_000_000

/** Error codes worth telling apart in the logs. Observed, not guessed. */
const NOT_AN_IMAGE = 9412
const DECODE_FAILED = 9516

const asStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  // `new Response(bytes).body` is the shortest route from bytes to the
  // ReadableStream the binding wants, and avoids constructing one by hand.
  new Response(bytes).body as ReadableStream<Uint8Array>

export function cloudflareImageConverter(
  images: ImagesBinding,
  log: (message: string) => void = console.warn,
): ImageConverter {
  return {
    async toJpeg(bytes: Uint8Array, declaredMimeType: string): Promise<ConvertedImage | null> {
      // Checked before spending a transformation, since both limits are hard
      // failures rather than degraded results.
      if (bytes.length > MAX_INPUT_BYTES) {
        log(`Not converting ${declaredMimeType}: ${bytes.length} bytes is past the 20MB input limit`)
        return null
      }

      try {
        // `info()` is free and authoritative about the format, which matters
        // because the declared type is the sender's client's opinion. It also
        // catches an oversized image before a transformation is billed.
        //
        // A stream cannot be read twice, so this gets its own.
        const info = await images.info(asStream(bytes))
        const sourceFormat = 'format' in info ? info.format : declaredMimeType

        if ('width' in info && info.width * info.height > MAX_PIXELS) {
          log(
            `Not converting ${sourceFormat}: ${info.width}x${info.height} is past the 100 megapixel limit`,
          )
          return null
        }

        const result = await images
          .input(asStream(bytes))
          .output({ format: 'image/jpeg', quality: JPEG_QUALITY })

        const converted = new Uint8Array(await result.response().arrayBuffer())
        return { bytes: converted, mimeType: 'image/jpeg', sourceFormat }
      } catch (error) {
        // Every failure mode observed here throws with a numeric code, so this
        // reports which one rather than a bare "conversion failed".
        const code = (error as { code?: number }).code
        const detail =
          code === NOT_AN_IMAGE
            ? 'not an image (a video or document, whatever the sender called it)'
            : code === DECODE_FAILED
              ? 'decode failed — truncated, or using features Images does not support'
              : String(error)
        log(`Conversion failed for ${declaredMimeType} (code ${code ?? 'none'}): ${detail}`)
        return null
      }
    },
  }
}
