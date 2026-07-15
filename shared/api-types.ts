// DTO между сервером и фронтом.
import type { Analysis } from './analysis';
import type { ArtifactType, RefRole } from './taxonomy';

export type ProjectStatus =
  | 'uploaded'
  | 'storyboarding'
  | 'storyboarded'
  | 'analyzing'
  | 'analyzed'
  | 'generating'
  | 'complete'
  | 'error';

export interface VideoMeta {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  aspect: string; // "9:16"
  sizeBytes: number;
}

export interface FrameInfo {
  file: string;
  t: number;
  kind: 'first' | 'scene' | 'grid';
}

export interface RefInfo {
  id: string;
  idx: number;
  role: RefRole;
  file: string;
  note: string;
}

export interface PromptRow {
  id: string;
  version: number;
  kind: 'image' | 'video';
  lang: string;
  text: string;
  params: SeedanceParams | null;
  createdAt: string;
}

export interface FeedbackRow {
  id: string;
  version: number;
  worked: boolean;
  artifacts: ArtifactType[];
  notes: string;
  createdAt: string;
}

export interface SeedanceParams {
  endpoint: string;
  video: string;
  reference_images: { index: number; whatItIs: string; file: string }[];
  aspect_ratio: string;
  resolution: string;
  enable_web_search: boolean;
  durationNote: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  status: ProjectStatus;
  error: string | null;
  createdAt: string;
  thumb: string | null;
  tags: string[];
  worked: boolean | null; // null = нет фидбека
  videoPurged: boolean;
  promptVersions: number;
}

export interface ProjectFull extends ProjectSummary {
  videoFile: string | null;
  meta: VideoMeta | null;
  frames: FrameInfo[];
  refs: RefInfo[];
  analysis: Analysis | null;
  prompts: PromptRow[];
  feedback: FeedbackRow[];
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  provider: string;
  model: string;
  keyPresent: boolean;
  ffmpeg: boolean;
  dataBytes: number;
  storageCapBytes: number;
  diskUsedPct: number;
}
