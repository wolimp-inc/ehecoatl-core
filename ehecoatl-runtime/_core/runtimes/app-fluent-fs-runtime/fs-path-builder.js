'use strict';

const path = require(`node:path`);

class FsPathBuilder {
  parentRuntime;
  rootName;
  primaryRootFolder;
  fallbackRootFolder;
  segments;

  constructor(
    parentRuntime,
    rootName,
    primaryRootFolder,
    fallbackRootFolder = null,
    segments = []
  ) {
    this.parentRuntime = parentRuntime ?? null;
    this.rootName = typeof rootName === `string`
      ? rootName.trim()
      : ``;
    this.primaryRootFolder = normalizeFolderPath(primaryRootFolder);
    this.fallbackRootFolder = normalizeFolderPath(fallbackRootFolder);
    this.segments = Object.freeze(normalizeSegments(segments));

    Object.freeze(this);
  }

  static create(
    parentRuntime,
    rootName,
    primaryRootFolder,
    fallbackRootFolder = null,
    segments = []
  ) {
    return createBuilderProxy(new FsPathBuilder(
      parentRuntime,
      rootName,
      primaryRootFolder,
      fallbackRootFolder,
      segments
    ));
  }

  child(segment) {
    return FsPathBuilder.create(
      this.parentRuntime,
      this.rootName,
      this.primaryRootFolder,
      this.fallbackRootFolder,
      [...this.segments, segment]
    );
  }

  path(filename = ``) {
    return this.#resolveTarget(filename).path;
  }

  readSync(filename, encoding = null) {
    return this.#getStorageService().readFileSync(this.path(filename), encoding);
  }

  writeSync(filename, content, encoding = `utf8`) {
    const resolvedTarget = this.#resolveTarget(filename);
    this.#ensureParentFolderSync(resolvedTarget.path);
    const writeResult = this.#getStorageService().writeFileSync(
      resolvedTarget.path,
      content,
      encoding
    );
    this.parentRuntime.refreshResolvedTarget(resolvedTarget);
    return writeResult;
  }

  existsSync(filename = ``) {
    return this.#getStorageService().fileExistsSync(this.path(filename));
  }

  async readAsync(filename, encoding = null) {
    return await this.#getStorageService().readFile(this.path(filename), encoding);
  }

  async writeAsync(filename, content, encoding = `utf8`) {
    const resolvedTarget = this.#resolveTarget(filename);
    await this.#ensureParentFolderAsync(resolvedTarget.path);
    const writeResult = await this.#getStorageService().writeFile(
      resolvedTarget.path,
      content,
      encoding
    );
    this.parentRuntime.refreshResolvedTarget(resolvedTarget);
    return writeResult;
  }

  async existsAsync(filename = ``) {
    return await this.#getStorageService().fileExists(this.path(filename));
  }

  async unlinkAsync(filename = ``) {
    const resolvedTarget = this.#resolveTarget(filename);
    return await this.#getStorageService().deleteFile(resolvedTarget.path);
  }

  #resolveTarget(filename = ``) {
    if (!this.parentRuntime || typeof this.parentRuntime.resolveTarget !== `function`) {
      throw new Error(`FsPathBuilder requires an AppFluentFsRuntime parent with resolveTarget()`);
    }

    return this.parentRuntime.resolveTarget({
      rootName: this.rootName,
      primaryRootFolder: this.primaryRootFolder,
      fallbackRootFolder: this.fallbackRootFolder,
      segments: this.segments,
      filename
    });
  }

  async #ensureParentFolderAsync(targetPath) {
    const parentFolder = path.dirname(String(targetPath ?? ``));
    if (!parentFolder || parentFolder === `.`) return;
    await this.#getStorageService().createFolder(parentFolder);
  }

  #ensureParentFolderSync(targetPath) {
    const parentFolder = path.dirname(String(targetPath ?? ``));
    if (!parentFolder || parentFolder === `.`) return;
    require(`node:fs`).mkdirSync(parentFolder, { recursive: true });
  }

  #getStorageService() {
    const storageService = this.parentRuntime?.storageService ?? null;
    if (!storageService) {
      throw new Error(`FsPathBuilder requires an AppFluentFsRuntime parent with storageService`);
    }
    return storageService;
  }
}

module.exports = FsPathBuilder;
Object.freeze(module.exports);

function createBuilderProxy(builder) {
  return new Proxy(builder, {
    get(target, property, receiver) {
      if (typeof property === `symbol`) {
        return Reflect.get(target, property, receiver);
      }

      if (property in target) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === `function`
          ? value.bind(target)
          : value;
      }

      const segment = String(property ?? ``).trim();
      if (!segment) {
        return Reflect.get(target, property, receiver);
      }

      return target.child(segment);
    }
  });
}

function normalizeFolderPath(folderPath) {
  return typeof folderPath === `string` && folderPath.trim()
    ? folderPath.trim()
    : null;
}

function normalizeSegments(segments) {
  return Array.isArray(segments)
    ? segments
      .map((segment) => typeof segment === `string` ? segment.trim() : ``)
      .filter(Boolean)
    : [];
}
