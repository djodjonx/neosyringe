// Générateur de messages de commit pour changesets
// Compatible avec commitlint (conventional commits)

/**
 * Message lors de l'ajout d'un changeset (changeset add)
 * @param {Object} changeset - Le changeset créé
 * @param {Object} options - Options (skipCI, etc.)
 * @returns {Promise<string>} Message de commit
 */
const getAddMessage = async (changeset, options) => {
  const skipCI = options?.skipCI === 'add' || options?.skipCI === true ? ' [skip ci]' : '';

  // Format: "chore(changeset): <summary>"
  return `chore(changeset): ${changeset.summary}${skipCI}`;
};

/**
 * Message lors du versioning (changeset version)
 * @param {Object} releasePlan - Plan de release avec les packages
 * @param {Object} options - Options (skipCI, etc.)
 * @returns {Promise<string>} Message de commit
 */
const getVersionMessage = async (releasePlan, options) => {
  const skipCI = options?.skipCI === 'version' || options?.skipCI === true ? ' [skip ci]' : '';

  const releases = releasePlan.releases
    .filter(release => release.type !== 'none')
    .map(release => ({
      name: release.name,
      version: release.newVersion,
      type: release.type
    }));

  if (releases.length === 0) {
    return `chore(release): version packages${skipCI}`;
  }

  // Titre uniforme avec la liste dans le body
  const packageList = releases
    .map(({ name, version }) => `- ${name}@${version}`)
    .join('\n');

  const count = releases.length === 1 ? '1 package' : `${releases.length} packages`;

  return `chore(release): version packages (${count})${skipCI}

${packageList}`;
};

module.exports = {
  getAddMessage,
  getVersionMessage,
};
