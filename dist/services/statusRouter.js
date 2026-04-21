/** Status lifecycle for the "Publicare bursa" column only. */
export async function setPublicationProcessing(monday, cfg, boardId, itemId) {
    await monday.changeStatusLabel(boardId, itemId, cfg.mondayColumns.publicationBursa, cfg.publicationBursa.processingLabel);
}
export async function setPublicationSuccess(monday, cfg, boardId, itemId) {
    await monday.changeStatusLabel(boardId, itemId, cfg.mondayColumns.publicationBursa, cfg.publicationBursa.successLabel);
}
export async function setPublicationError(monday, cfg, boardId, itemId) {
    await monday.changeStatusLabel(boardId, itemId, cfg.mondayColumns.publicationBursa, cfg.publicationBursa.errorLabel);
}
