import type { MondayClient } from "./mondayClient.js";
import type { AppConfig } from "../utils/config.js";

/** Status lifecycle for the "Publicare bursa" column (`color_mkyp8xqz`) only. */
export async function setPublicationProcessing(
  monday: MondayClient,
  cfg: AppConfig,
  boardId: number | string,
  itemId: number | string
) {
  await monday.changeStatusLabel(
    boardId,
    itemId,
    cfg.mondayColumns.publicationBursa,
    cfg.publicationBursa.processingLabel
  );
}

export async function setPublicationSuccess(
  monday: MondayClient,
  cfg: AppConfig,
  boardId: number | string,
  itemId: number | string
) {
  await monday.changeStatusLabel(
    boardId,
    itemId,
    cfg.mondayColumns.publicationBursa,
    cfg.publicationBursa.successLabel
  );
}

export async function setPublicationError(
  monday: MondayClient,
  cfg: AppConfig,
  boardId: number | string,
  itemId: number | string
) {
  await monday.changeStatusLabel(
    boardId,
    itemId,
    cfg.mondayColumns.publicationBursa,
    cfg.publicationBursa.errorLabel
  );
}
