import { HttpException, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { journeyDirectUploadMetadataSchema, stagedUploadIntentSchema, type JourneyDirectUploadRequest } from '@trek/shared';
import type { JourneyPhoto, User } from '../../types';
import { RuntimeEnvService } from '../app-config/runtime-env.service';
import { DEMO_WRITE_ERROR, isDemoWriteBlocked } from '../common/demo-write';
import { AllowedFileTypesService } from '../files/allowed-file-types.service';
import { PhotoCaptureBackfillService } from '../memories/photo-capture-backfill.service';
import { StagedUploadsService } from '../storage/staged-uploads.service';
import { JourneyDomainService } from './journey-domain.service';
import { JourneyService } from './journey.service';
import { JOURNEY_UPLOAD_SCOPES, validateJourneyUploadFiles, type JourneyUploadScope } from './journey-direct-uploads.policy';

@Injectable()
export class JourneyDirectUploadsService implements OnModuleInit {
  private readonly logger = new Logger(JourneyDirectUploadsService.name);

  constructor(
    private readonly staged: StagedUploadsService,
    private readonly domain: JourneyDomainService,
    private readonly journey: JourneyService,
    private readonly allowedTypes: AllowedFileTypesService,
    private readonly capture: PhotoCaptureBackfillService,
    private readonly env: RuntimeEnvService,
  ) {}

  onModuleInit(): void {
    for (const scope of JOURNEY_UPLOAD_SCOPES) {
      this.staged.registerAuthorizer(scope, (intent, user) => {
        this.authorize(scope, intent.targetId, user);
        journeyDirectUploadMetadataSchema.parse(intent.metadata);
        validateJourneyUploadFiles(scope, intent.files, this.allowedTypes.get());
      });
    }
  }

  private authorize(scope: JourneyUploadScope, targetId: string, user: User): number {
    if (!this.journey.journeyAddonEnabled()) throw new HttpException({ error: 'Journey is not available' }, 404);
    const id = Number(targetId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpException({ error: 'Journey not found' }, 404);
    if (isDemoWriteBlocked(this.env, user.email)) throw new HttpException(DEMO_WRITE_ERROR, 403);
    const permitted = scope === 'journey-cover' ? this.domain.isOwner(id, user.id)
      : scope.startsWith('journey-entry-') ? this.domain.canEditEntry(id, user.id)
      : this.domain.canEdit(id, user.id);
    if (!permitted) throw new HttpException({ error: scope === 'journey-cover' ? 'Journey not found' : 'Not allowed' }, scope === 'journey-cover' ? 404 : 403);
    return id;
  }

  async create(scope: JourneyUploadScope, targetId: string, user: User, body: JourneyDirectUploadRequest) {
    this.authorize(scope, targetId, user);
    validateJourneyUploadFiles(scope, body.files, this.allowedTypes.get());
    const intent = this.staged.create(user.id, scope, targetId, body.metadata, body.files.map(file => ({
      ...file,
      // Never give a poster its untrusted extension: x.html declared image/*
      // must not become an executable same-origin document.
      originalName: file.fieldname === 'poster' ? 'poster.jpg' : file.originalName,
      category: 'journey' as const,
    })));
    return stagedUploadIntentSchema.parse({ ...intent, files: intent.files.map(({ category: _category, ...file }) => file) });
  }

  async complete(scope: JourneyUploadScope, targetId: string, user: User, uploadId: string) {
    const target = this.authorize(scope, targetId, user);
    const intent = this.staged.get(uploadId, user.id, scope, targetId);
    const metadata = journeyDirectUploadMetadataSchema.parse(intent.metadata);
    validateJourneyUploadFiles(scope, intent.files, this.allowedTypes.get());
    if (intent.completedAt === null) await this.staged.verify(intent);
    let added: JourneyPhoto[] = [];
    const completion = this.staged.complete(intent, () => {
      // Permissions may have changed while the remote object metadata was read.
      this.authorize(scope, targetId, user);
      if (scope === 'journey-cover') {
        const result = this.journey.updateJourney(target, user.id, { cover_image: `journey/${intent.files[0].filename}` });
        if (!result) throw new HttpException({ error: 'Journey not found' }, 404);
        return result;
      }
      const video = intent.files.find(file => file.fieldname === 'video');
      const poster = intent.files.find(file => file.fieldname === 'poster');
      const originals = video ? [video] : intent.files;
      const paths = originals.map(file => ({
        path: `journey/${file.filename}`,
        thumbnail: poster ? `journey/${poster.filename}` : undefined,
        mediaType: video ? 'video' : 'image',
        durationMs: video && metadata.duration_ms !== undefined ? Number(metadata.duration_ms) : null,
      }));
      if (scope.startsWith('journey-entry-')) {
        added = paths.map(file => {
          const photo = this.journey.addPhoto(target, user.id, file.path, file.thumbnail,
            metadata.caption, { mediaType: file.mediaType, durationMs: file.durationMs });
          if (!photo) throw new HttpException({ error: 'Not allowed' }, 403);
          return photo;
        });
      } else {
        added = this.journey.uploadGalleryPhotos(target, user.id, paths);
        if (added.length !== paths.length) throw new HttpException({ error: 'Not allowed' }, 403);
      }
      return { photos: added };
    });

    if (completion.created && added.length && !scope.endsWith('-video')) {
      // Await EXIF on serverless: returning first may freeze this invocation.
      // Read the retained originals before any optional provider mirroring.
      await this.capture.run(added.map(photo => photo.photo_id), user.id);
      if (scope === 'journey-entry-photos' && this.journey.immichAutoUploadEnabled(user.id)) {
        for (const [index, photo] of added.entries()) {
          try {
            const source = intent.files[index];
            const assetId = await this.journey.uploadToImmich(user.id, `journey/${source.filename}`, source.originalName);
            if (assetId) {
              this.journey.setPhotoProvider(photo.id, 'immich', assetId, user.id);
              Object.assign(photo, { provider: 'immich', asset_id: assetId, owner_id: user.id });
            }
          } catch (error) {
            this.logger.warn(`Optional Immich mirror failed for photo ${photo.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    return completion.created && added.length ? { photos: added } : completion.result;
  }
}
