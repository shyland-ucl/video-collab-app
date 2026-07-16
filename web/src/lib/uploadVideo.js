import * as tus from 'tus-js-client'

// Supabase Storage resumable uploads require exactly 6MiB chunks.
const CHUNK_SIZE = 6 * 1024 * 1024

export function uploadVideo({ supabaseUrl, accessToken, objectName, file, onProgress }) {
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-upsert': 'true',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: CHUNK_SIZE,
      // tus' browser default fingerprints only the file + endpoint. Include
      // the destination object so the same interrupted file selected for a
      // different project/video can never resume into the old storage path.
      fingerprint: (uploadFile, options) => Promise.resolve([
        'video-collab',
        options.metadata?.objectName ?? objectName,
        uploadFile.name,
        uploadFile.type,
        uploadFile.size,
        uploadFile.lastModified,
        options.endpoint,
      ].join('|')),
      metadata: {
        bucketName: 'videos',
        objectName,
        contentType: file.type || 'video/mp4',
        cacheControl: '3600',
      },
      onError: reject,
      onProgress: (sent, total) => {
        if (total > 0) onProgress?.(Math.round((sent / total) * 100))
      },
      onSuccess: () => resolve(),
    })

    upload.findPreviousUploads()
      .then((previous) => {
        if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0])
        upload.start()
      })
      .catch(reject)
  })
}
