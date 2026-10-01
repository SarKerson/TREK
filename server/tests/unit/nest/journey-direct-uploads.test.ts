import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { JourneyDirectUploadRequest } from '@trek/shared';
import type { JourneyPhoto, User } from '../../../src/types';
import type { RuntimeEnvService } from '../../../src/nest/app-config/runtime-env.service';
import type { AllowedFileTypesService } from '../../../src/nest/files/allowed-file-types.service';
import type { PhotoCaptureBackfillService } from '../../../src/nest/memories/photo-capture-backfill.service';
import type { StagedFileInput, StagedUploadIntent, StagedUploadsService } from '../../../src/nest/storage/staged-uploads.service';
import type { JourneyDomainService } from '../../../src/nest/journey/journey-domain.service';
import type { JourneyService } from '../../../src/nest/journey/journey.service';
import { JourneyDirectUploadsController } from '../../../src/nest/journey/journey-direct-uploads.controller';
import { JourneyDirectUploadsService } from '../../../src/nest/journey/journey-direct-uploads.service';
import { validateJourneyUploadFiles } from '../../../src/nest/journey/journey-direct-uploads.policy';

const user = { id: 1, email: 'family@example.test' } as User;
const uploadId = 'd0d87cd9-6bc2-4c11-90ad-c9627e9fccdc';
const photoFile: JourneyDirectUploadRequest['files'][number] = {
  fieldname: 'photos', originalName: 'vacation.jpg', contentType: 'image/jpeg', size: 250,
};
const videoFile: JourneyDirectUploadRequest['files'][number] = {
  fieldname: 'video', originalName: 'vacation.mov', contentType: 'video/quicktime', size: 100_000_000,
};
const posterFile: JourneyDirectUploadRequest['files'][number] = {
  fieldname: 'poster', originalName: 'untrusted.html', contentType: 'image/jpeg', size: 100,
};
const photo = { id: 4, photo_id: 7, file_path: 'journey/original.jpg', provider: 'local' } as JourneyPhoto;

function intent(files: JourneyDirectUploadRequest['files'] = [photoFile]): StagedUploadIntent {
  return {
    id: uploadId, userId: 1, scope: 'journey-entry-photos', targetId: '9', metadata: {},
    files: files.map((file, index) => ({ ...file, category: 'journey', filename: `${index}-original.jpg`, pathname: `journey/${index}-original.jpg` })),
    expiresAt: Date.now() + 3600_000, completedAt: null, result: null,
  };
}

function setup() {
  const saved = intent();
  const staged = {
    registerAuthorizer: vi.fn<(scope: string, authorize: (intent: StagedUploadIntent, user: User) => void) => void>(),
    create: vi.fn((_userId: number, _scope: string, _targetId: string, metadata: unknown, files: StagedFileInput[]) => ({
      ...saved, metadata, files: files.map((file, index) => ({ ...file, filename: `${index}.jpg`, pathname: `journey/${index}.jpg` })),
    })),
    get: vi.fn(() => saved),
    verify: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn((_intent: StagedUploadIntent, create: () => unknown) => ({ result: create(), created: true })),
  };
  const domain = { isOwner: vi.fn(() => true), canEdit: vi.fn(() => true), canEditEntry: vi.fn(() => true) };
  const journey = {
    journeyAddonEnabled: vi.fn(() => true),
    addPhoto: vi.fn(() => ({ ...photo })),
    uploadGalleryPhotos: vi.fn(() => [{ ...photo }]),
    updateJourney: vi.fn(() => ({ id: 9, cover_image: 'journey/0-original.jpg' })),
    immichAutoUploadEnabled: vi.fn(() => false),
    uploadToImmich: vi.fn().mockResolvedValue('immich-asset'),
    setPhotoProvider: vi.fn(),
  };
  const allowed = { get: vi.fn(() => 'jpg,jpeg,png,heic') };
  const capture = { run: vi.fn().mockResolvedValue(undefined) };
  const env = { isDemoMode: vi.fn(() => false) };
  const service = new JourneyDirectUploadsService(staged as unknown as StagedUploadsService,
    domain as unknown as JourneyDomainService, journey as unknown as JourneyService,
    allowed as unknown as AllowedFileTypesService, capture as unknown as PhotoCaptureBackfillService,
    env as unknown as RuntimeEnvService);
  return { service, staged, domain, journey, allowed, capture, env, saved };
}

beforeEach(() => vi.clearAllMocks());

describe('journey direct upload policy', () => {
  it('keeps image originals and supports the 500 MB video limit', () => {
    expect(() => validateJourneyUploadFiles('journey-entry-photos', [photoFile], 'jpg')).not.toThrow();
    expect(() => validateJourneyUploadFiles('journey-gallery-video', [{ ...videoFile, size: 500 * 1024 * 1024 }, posterFile], 'jpg')).not.toThrow();
  });

  it.each([
    { ...photoFile, size: 21 * 1024 * 1024 },
    { ...photoFile, size: 0 },
    { ...photoFile, contentType: 'image/svg+xml' },
    { ...photoFile, contentType: 'text/html' },
    { ...photoFile, originalName: 'x.svg' },
    { ...photoFile, originalName: 'x.html' },
    { ...photoFile, originalName: 'x.js' },
  ])('rejects unsafe/oversized images even with wildcard types: $originalName $contentType', file => {
    expect(() => validateJourneyUploadFiles('journey-entry-photos', [file], '*')).toThrow(HttpException);
  });

  it('enforces the admin extension policy', () => {
    expect(() => validateJourneyUploadFiles('journey-gallery-photos', [photoFile], 'png')).toThrow(HttpException);
  });

  it('rejects invalid video composition and MIME/extension spoofing', () => {
    for (const files of [[posterFile], [videoFile, videoFile], [videoFile, posterFile, posterFile], [videoFile, photoFile]]) {
      expect(() => validateJourneyUploadFiles('journey-gallery-video', files, '*')).toThrow(HttpException);
    }
    expect(() => validateJourneyUploadFiles('journey-entry-video', [{ ...videoFile, originalName: 'x.html' }], '*')).toThrow(HttpException);
    expect(() => validateJourneyUploadFiles('journey-entry-video', [{ ...videoFile, contentType: 'text/html' }], '*')).toThrow(HttpException);
    expect(() => validateJourneyUploadFiles('journey-entry-video', [{ ...videoFile, size: 501 * 1024 * 1024 }], '*')).toThrow(HttpException);
  });

  it('requires exactly one cover and only photo fields for images', () => {
    expect(() => validateJourneyUploadFiles('journey-cover', [{ ...photoFile, fieldname: 'cover' }], '*')).not.toThrow();
    for (const files of [[], [photoFile], [{ ...photoFile, fieldname: 'cover' }, { ...photoFile, fieldname: 'cover' }]]) {
      expect(() => validateJourneyUploadFiles('journey-cover', files, '*')).toThrow(HttpException);
    }
    expect(() => validateJourneyUploadFiles('journey-entry-photos', [videoFile], '*')).toThrow(HttpException);
  });
});

describe('JourneyDirectUploadsService', () => {
  it('registers every grant scope and rechecks permissions, addon and file policy at grant time', () => {
    const { service, staged, domain, journey, allowed, saved } = setup();
    service.onModuleInit();
    expect(staged.registerAuthorizer.mock.calls.map(call => call[0])).toEqual([
      'journey-entry-photos', 'journey-entry-video', 'journey-gallery-photos', 'journey-gallery-video', 'journey-cover',
    ]);
    const authorize = staged.registerAuthorizer.mock.calls[0][1];
    expect(() => authorize(saved, user)).not.toThrow();
    domain.canEditEntry.mockReturnValue(false);
    expect(() => authorize(saved, user)).toThrow(HttpException);
    domain.canEditEntry.mockReturnValue(true);
    allowed.get.mockReturnValue('png');
    expect(() => authorize(saved, user)).toThrow(HttpException);
    allowed.get.mockReturnValue('jpg');
    journey.journeyAddonEnabled.mockReturnValue(false);
    expect(() => authorize(saved, user)).toThrow(HttpException);
  });

  it('binds the intent to actor, scope and target and strips internal fields from the response', async () => {
    const { service, staged } = setup();
    const result = await service.create('journey-entry-photos', '9', user, { files: [photoFile], metadata: { caption: 'Original' } });
    expect(staged.create).toHaveBeenCalledWith(1, 'journey-entry-photos', '9', { caption: 'Original' }, [{ ...photoFile, category: 'journey' }]);
    expect(result).not.toHaveProperty('metadata');
    expect(result).not.toHaveProperty('userId');
  });

  it('forces a harmless poster extension independently of the client name', async () => {
    const { service, staged } = setup();
    await service.create('journey-entry-video', '9', user, { files: [videoFile, posterFile], metadata: {} });
    expect(staged.create.mock.calls[0][4][1]).toMatchObject({ originalName: 'poster.jpg', contentType: 'image/jpeg', category: 'journey' });
  });

  it('does not create intents for outsiders, viewers or non-owner cover editors', async () => {
    const { service, staged, domain } = setup();
    domain.canEditEntry.mockReturnValue(false);
    domain.canEdit.mockReturnValue(false);
    domain.isOwner.mockReturnValue(false);
    await expect(service.create('journey-entry-photos', '9', user, { files: [photoFile], metadata: {} })).rejects.toThrow(HttpException);
    await expect(service.create('journey-gallery-photos', '9', user, { files: [photoFile], metadata: {} })).rejects.toThrow(HttpException);
    await expect(service.create('journey-cover', '9', user, { files: [{ ...photoFile, fieldname: 'cover' }], metadata: {} })).rejects.toThrow(HttpException);
    await expect(service.create('journey-entry-photos', 'NaN', user, { files: [photoFile], metadata: {} })).rejects.toThrow(HttpException);
    expect(staged.create).not.toHaveBeenCalled();
  });

  it('validates destination binding before reading remote bytes', async () => {
    const { service, staged, journey } = setup();
    staged.get.mockImplementation(() => { throw new HttpException({ error: 'Upload not found' }, 404); });
    await expect(service.complete('journey-entry-photos', '9', user, uploadId)).rejects.toThrow(HttpException);
    expect(staged.get).toHaveBeenCalledWith(uploadId, user.id, 'journey-entry-photos', '9');
    expect(staged.verify).not.toHaveBeenCalled();
    expect(journey.addPhoto).not.toHaveBeenCalled();
  });

  it('preserves original paths, captions and EXIF processing after verified upload', async () => {
    const { service, staged, journey, capture, saved } = setup();
    saved.metadata = { caption: 'With family' };
    const result = await service.complete('journey-entry-photos', '9', user, uploadId);
    expect(staged.verify).toHaveBeenCalledWith(saved);
    expect(journey.addPhoto).toHaveBeenCalledWith(9, 1, 'journey/0-original.jpg', undefined, 'With family', { mediaType: 'image', durationMs: null });
    expect(capture.run).toHaveBeenCalledWith([7], 1);
    expect(result).toEqual({ photos: [photo] });
  });

  it('rechecks permission after remote verification and before committing', async () => {
    const { service, domain, journey } = setup();
    domain.canEditEntry.mockReturnValueOnce(true).mockReturnValue(false);
    await expect(service.complete('journey-entry-photos', '9', user, uploadId)).rejects.toThrow(HttpException);
    expect(journey.addPhoto).not.toHaveBeenCalled();
  });

  it('never finalizes bytes that fail verification or current type restrictions', async () => {
    const { service, staged, journey, allowed } = setup();
    staged.verify.mockRejectedValueOnce(new HttpException({ error: 'Uploaded file does not match its upload grant' }, 400));
    await expect(service.complete('journey-entry-photos', '9', user, uploadId)).rejects.toThrow(HttpException);
    allowed.get.mockReturnValue('png');
    await expect(service.complete('journey-entry-photos', '9', user, uploadId)).rejects.toThrow(HttpException);
    expect(staged.complete).not.toHaveBeenCalled();
    expect(journey.addPhoto).not.toHaveBeenCalled();
  });

  it('replays finalization without duplicate rows or optional side effects', async () => {
    const { service, staged, journey, capture, saved } = setup();
    saved.completedAt = Date.now();
    saved.result = { photos: [photo] };
    staged.complete.mockReturnValue({ result: saved.result, created: false });
    expect(await service.complete('journey-entry-photos', '9', user, uploadId)).toEqual(saved.result);
    expect(staged.verify).not.toHaveBeenCalled();
    expect(journey.addPhoto).not.toHaveBeenCalled();
    expect(capture.run).not.toHaveBeenCalled();
  });

  it.each(['journey-entry-video', 'journey-gallery-video'] as const)('preserves clip, poster and duration for %s', async scope => {
    const { service, staged, journey, capture } = setup();
    const saved = intent([videoFile, { ...posterFile, originalName: 'poster.jpg' }]);
    saved.metadata = { duration_ms: '1234' };
    staged.get.mockReturnValue(saved);
    await service.complete(scope, '9', user, uploadId);
    if (scope === 'journey-entry-video') {
      expect(journey.addPhoto).toHaveBeenCalledWith(9, 1, 'journey/0-original.jpg', 'journey/1-original.jpg', undefined,
        { mediaType: 'video', durationMs: 1234 });
    } else {
      expect(journey.uploadGalleryPhotos).toHaveBeenCalledWith(9, 1, [{ path: 'journey/0-original.jpg', thumbnail: 'journey/1-original.jpg', mediaType: 'video', durationMs: 1234 }]);
    }
    expect(capture.run).not.toHaveBeenCalled();
  });

  it('finishes gallery photos and owner-only covers through the existing domain', async () => {
    const { service, staged, journey, capture } = setup();
    await service.complete('journey-gallery-photos', '9', user, uploadId);
    expect(journey.uploadGalleryPhotos).toHaveBeenCalledWith(9, 1, [{ path: 'journey/0-original.jpg', thumbnail: undefined, mediaType: 'image', durationMs: null }]);
    expect(capture.run).toHaveBeenCalledWith([7], 1);
    staged.get.mockReturnValue(intent([{ ...photoFile, fieldname: 'cover' }]));
    expect(await service.complete('journey-cover', '9', user, uploadId)).toEqual({ id: 9, cover_image: 'journey/0-original.jpg' });
  });

  it('preserves the user’s opted-in Immich mirror without discarding originals', async () => {
    const { service, journey, capture } = setup();
    journey.immichAutoUploadEnabled.mockReturnValue(true);
    const result = await service.complete('journey-entry-photos', '9', user, uploadId);
    expect(capture.run.mock.invocationCallOrder[0]).toBeLessThan(journey.uploadToImmich.mock.invocationCallOrder[0]);
    expect(journey.uploadToImmich).toHaveBeenCalledWith(1, 'journey/0-original.jpg', 'vacation.jpg');
    expect(journey.setPhotoProvider).toHaveBeenCalledWith(4, 'immich', 'immich-asset', 1);
    expect(result).toEqual({ photos: [{ ...photo, provider: 'immich', asset_id: 'immich-asset', owner_id: 1 }] });
  });

  it('keeps saved originals usable when an optional mirror fails', async () => {
    const { service, journey } = setup();
    journey.immichAutoUploadEnabled.mockReturnValue(true);
    journey.uploadToImmich.mockRejectedValue(new Error('Provider unavailable'));
    expect(await service.complete('journey-entry-photos', '9', user, uploadId)).toEqual({ photos: [photo] });
    expect(journey.setPhotoProvider).not.toHaveBeenCalled();
  });
});

describe('JourneyDirectUploadsController', () => {
  it('maps all five JSON route pairs to their exact scope and target', () => {
    const uploads = { create: vi.fn(), complete: vi.fn() };
    const controller = new JourneyDirectUploadsController(uploads as unknown as JourneyDirectUploadsService);
    const body = { files: [photoFile], metadata: {} };
    const routes = [
      ['createEntryPhotos', 'completeEntryPhotos', 'journey-entry-photos'],
      ['createEntryVideo', 'completeEntryVideo', 'journey-entry-video'],
      ['createGalleryPhotos', 'completeGalleryPhotos', 'journey-gallery-photos'],
      ['createGalleryVideo', 'completeGalleryVideo', 'journey-gallery-video'],
      ['createCover', 'completeCover', 'journey-cover'],
    ] as const;
    for (const [create, complete, scope] of routes) {
      controller[create](user, '9', body);
      expect(uploads.create).toHaveBeenLastCalledWith(scope, '9', user, body);
      controller[complete](user, '9', { id: uploadId });
      expect(uploads.complete).toHaveBeenLastCalledWith(scope, '9', user, uploadId);
    }
  });
});
