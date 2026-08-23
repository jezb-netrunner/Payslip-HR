import { useEffect, useRef, useState } from 'react'
import { Camera, RefreshCw } from 'lucide-react'
import { Button } from './ui'

/**
 * Webcam selfie capture for punch verification. Returns a JPEG blob.
 * Falls back gracefully when no camera is available.
 */
export default function CameraCapture({
  onCapture,
  onUnavailable,
}: {
  onCapture: (blob: Blob) => void
  onUnavailable?: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [captured, setCaptured] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        setReady(true)
      } catch {
        setFailed(true)
        onUnavailable?.()
      }
    }
    start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function capture() {
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 640
    canvas.height = video.videoHeight || 480
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(
      (blob) => {
        if (blob) {
          setCaptured(canvas.toDataURL('image/jpeg', 0.8))
          onCapture(blob)
        }
      },
      'image/jpeg',
      0.8,
    )
  }

  if (failed) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-center text-xs text-amber-700">
        Camera unavailable. If your company requires a punch selfie, enable camera access and
        reload.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-xl bg-slate-900">
        {captured ? (
          <img src={captured} alt="Captured selfie" className="aspect-[4/3] w-full object-cover" />
        ) : (
          <video ref={videoRef} playsInline muted className="aspect-[4/3] w-full -scale-x-100 object-cover" />
        )}
        {!ready && !captured && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
            Starting camera…
          </div>
        )}
      </div>
      <div className="flex justify-center gap-2">
        {captured ? (
          <Button variant="secondary" onClick={() => setCaptured(null)}>
            <RefreshCw className="size-4" /> Retake
          </Button>
        ) : (
          <Button onClick={capture} disabled={!ready}>
            <Camera className="size-4" /> Capture selfie
          </Button>
        )}
      </div>
    </div>
  )
}
