const CATEGORY_CODES = {
  S: "Singles",
  SE: "Sealed",
  SL: "Slabs",
  O: "Other"
};

function parseQrPayload(rawValue) {
  const rawText = String(rawValue || "").trim();
  if (!rawText) {
    return {
      cardId: "",
      name: "",
      cost: "",
      category: "Singles",
      notes: "",
      owner: "",
      parseStatus: "empty",
      parseError: "Empty QR payload"
    };
  }

  if (!rawText.includes("=")) {
    return {
      cardId: rawText,
      name: rawText,
      cost: "",
      category: "Singles",
      notes: "",
      owner: "",
      parseStatus: "parsed_card_id",
      parseError: ""
    };
  }

  try {
    const fields = {};
    rawText.split(";")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .forEach((segment) => {
        const equalsIndex = segment.indexOf("=");
        if (equalsIndex === -1) {
          return;
        }
        fields[segment.slice(0, equalsIndex).trim().toUpperCase()] = segment.slice(equalsIndex + 1).trim();
      });

    if (!fields.N || !fields.O || !fields.C || !fields.G) {
      throw new Error("Expected N, O, C, and G fields.");
    }
    if (!CATEGORY_CODES[fields.G]) {
      throw new Error("Unsupported category code: " + fields.G);
    }

    return {
      cardId: "",
      name: fields.N,
      cost: fields.C,
      category: CATEGORY_CODES[fields.G],
      notes: "",
      owner: fields.O,
      parseStatus: "parsed_compact",
      parseError: ""
    };
  } catch (error) {
    return {
      cardId: "",
      name: rawText,
      cost: "",
      category: "Singles",
      notes: "",
      owner: "",
      parseStatus: "invalid_compact_payload",
      parseError: error.message
    };
  }
}

function buildCaptureScans({ qrValues, messageId, attachmentIndex, analysis }) {
  const values = Array.isArray(qrValues) ? qrValues : [];
  if (!values.length) {
    return [{
      qrIndex: 0,
      recordKey: ["discord", messageId || "", attachmentIndex || 0, 0].join(":"),
      cardId: "",
      name: "",
      cost: "",
      category: "Singles",
      quantity: 1,
      total: "",
      notes: "",
      parseStatus: "no_code_found",
      parseError: analysis && analysis.noCodeReason ? analysis.noCodeReason : "No QR code found"
    }];
  }

  return values.map((rawValue, index) => {
    const parsed = parseQrPayload(rawValue);
    return {
      qrIndex: index + 1,
      recordKey: ["discord", messageId || "", attachmentIndex || 0, index + 1].join(":"),
      cardId: parsed.cardId,
      name: parsed.name,
      cost: parsed.cost,
      category: parsed.category,
      quantity: 1,
      total: parsed.cost,
      notes: parsed.notes,
      owner: parsed.owner,
      parseStatus: parsed.parseStatus,
      parseError: parsed.parseError,
      rawValue
    };
  });
}

module.exports = {
  parseQrPayload,
  buildCaptureScans
};
