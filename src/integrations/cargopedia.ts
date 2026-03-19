import axios from "axios";
import { config } from "../config";
import { IntegrationContext, IntegrationResult } from "./types";

/**
 * 🔹 MAP TRUCK TYPE (Monday → Cargopedia)
 */
function mapTruckType(mondayValue: string): {
  truck_type: string;
  reefer?: number;
} {
  if (!mondayValue) return { truck_type: "tilt" };

  const v = mondayValue.toLowerCase();

  if (v.includes("prelata") || v.includes("curtain")) {
    return { truck_type: "tilt" };
  }

  if (v.includes("box") || v.includes("rigid")) {
    return { truck_type: "box" };
  }

  if (v.includes("frigo") || v.includes("reefer")) {
    return {
      truck_type: "box",
      reefer: 1,
    };
  }

  if (v.includes("tipper")) {
    return { truck_type: "tipper" };
  }

  if (v.includes("cistern") || v.includes("tanker")) {
    if (v.includes("food")) {
      return { truck_type: "liquidfoodtank" };
    }
    return { truck_type: "tank" };
  }

  if (v.includes("container")) {
    return { truck_type: "container" };
  }

  if (v.includes("flatbed") || v.includes("platform")) {
    return { truck_type: "flatbed" };
  }

  if (v.includes("car transporter") || v.includes("auto")) {
    return { truck_type: "cartransporter" };
  }

  if (v.includes("crane") || v.includes("hiab")) {
    return { truck_type: "crane" };
  }

  if (v.includes("tractor")) {
    return { truck_type: "tractorunit" };
  }

  if (v.includes("sliding floor")) {
    return { truck_type: "openbody" };
  }

  console.warn("[CARGOPEDIA] Unknown truck type:", mondayValue);

  return { truck_type: "tilt" };
}

/**
 * 🔹 MAP CARGO TYPE (Tip Marfa)
 */
function mapCargoType(mondayValue: string): {
  adr?: number;
  reefer?: number;
  forceTruckType?: string;
} {
  if (!mondayValue) return {};

  const v = mondayValue.toLowerCase();

  const result: any = {};

  if (v.includes("adr")) {
    result.adr = 1;
  }

  if (v.includes("frigo")) {
    result.reefer = 1;
  }

  if (v.includes("car")) {
    result.forceTruckType = "cartransporter";
  }

  return result;
}

/**
 * 🔹 PUBLICARE LOAD
 */
export async function publishLoad(
  context: IntegrationContext
): Promise<IntegrationResult> {
  try {
    const item = context.item;
    const columns = context.columns;

    // 🔹 MAPARE DATE DIN MONDAY (ajustează dacă ai alte chei)
    const from =
      `${columns["Localitate Incarcare"]},${columns["Tara Incarcare"]}`;

    const to =
      `${columns["Localitate Descarcare"]},${columns["Tara Descarcare"]}`;

    const weight = parseFloat(columns["Greutate (KG)"] || "0") / 1000;

    const price = columns["Buget Client"];
    const transportType = columns["Tip Mijloc Transport"];
    const cargoType = columns["Tip Marfa"];
    const description = columns["Descriere Marfa"];

    if (!from || !to || !weight) {
      return {
        status: "error",
        message: "[CARGOPEDIA] Missing required fields",
      };
    }

    // 🔹 TRUCK TYPE
    const { truck_type: baseTruckType, reefer: reeferFromTruck } =
      mapTruckType(transportType);

    // 🔹 CARGO TYPE
    const {
      adr,
      reefer: reeferFromCargo,
      forceTruckType,
    } = mapCargoType(cargoType);

    const finalTruckType = forceTruckType || baseTruckType;

    const reefer =
      reeferFromCargo || reeferFromTruck ? 1 : undefined;

    // 🔹 PARAMS CARGOPEDIA
    const params: any = {
      key: config.integrations.cargopedia.apiKey,
      user_id: config.integrations.cargopedia.userId,

      from,
      to,
      weight,

      truck_type: finalTruckType,
      lang: "en",

      oid: item.id,
    };

    if (price) {
      params.price = price;
      params.price_unit = "EUR";
    }

    if (adr) {
      params.adr = adr;
    }

    if (reefer) {
      params.reefer = reefer;
    }

    if (description) {
      params.description = description;
    }

    // 🔹 DEBUG
    console.log("[CARGOPEDIA] Payload:", params);

    const response = await axios.get(
      `${config.integrations.cargopedia.baseUrl}/api/v1/loads/publish`,
      { params }
    );

    const data = response.data;

    if (!data.ok) {
      return {
        status: "error",
        message: `[CARGOPEDIA] ${data.message}`,
      };
    }

    return {
      status: "success",
      message: `[CARGOPEDIA] ${data.message}`,
      externalId: data.id,
    };
  } catch (error: any) {
    console.error("[CARGOPEDIA ERROR]", error);

    return {
      status: "error",
      message: `[CARGOPEDIA] ${error.message}`,
    };
  }
}

/**
 * 🔹 STERGERE LOAD
 */
export async function removeLoad(
  externalId: string
): Promise<IntegrationResult> {
  try {
    const params = {
      key: config.integrations.cargopedia.apiKey,
      user_id: config.integrations.cargopedia.userId,
      oid: externalId,
    };

    const response = await axios.get(
      `${config.integrations.cargopedia.baseUrl}/api/v1/loads/delete`,
      { params }
    );

    const data = response.data;

    if (!data.ok) {
      return {
        status: "error",
        message: `[CARGOPEDIA] ${data.message}`,
      };
    }

    return {
      status: "success",
      message: `[CARGOPEDIA] ${data.message}`,
    };
  } catch (error: any) {
    console.error("[CARGOPEDIA DELETE ERROR]", error);

    return {
      status: "error",
      message: `[CARGOPEDIA] ${error.message}`,
    };
  }
}
