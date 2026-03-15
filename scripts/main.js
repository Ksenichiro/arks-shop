const MODULE_ID = "ARKS-Shop";
const EQUIPMENT_COMPENDIUM_SETTING = "selectedEquipmentCompendiums";
const EQUIPMENT_COMPENDIUMS_INITIALIZED_SETTING = "equipmentCompendiumsInitialized";
const EQUIPMENT_PACK_PATTERN = /(equipment|weapon|armor|clothing|gear|money)/i;
const SELLABLE_ITEM_TYPES = new Set(["item", "weapon", "armor"]);
const INSTRUMENT_ITEM_PATTERN =
  /\b(instrument|lute|lyre|harp|drum|flute|pan flute|pipes?|bagpipes?|horn|trumpet|shawm|fiddle|viol|mandolin|gittern|recorder|cymbal|tambourine)\b/i;
const ITEM_DIRECTORY_ID = "items";

let shopApp;
let splitCostsApp;
let shopInventoryCache = [];
let shopInventoryCacheKey = "";

class ArksShopApp extends Application {
  constructor(options = {}) {
    super(options);
    this.selectedActorId = options.actorId ?? "";
    this.searchTerm = options.searchTerm ?? "";
    this.availabilityFilter = options.availabilityFilter ?? "all";
    this.compendiumFilters = new Set();
    this.typeFilters = new Set();
    this.#filtersInitialized = {
      compendiums: false,
      types: false
    };
    this.#knownFilterValues = {
      compendiums: new Set(),
      types: new Set()
    };
  }

  #filtersInitialized;
  #knownFilterValues;

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-app`,
      classes: [MODULE_ID.toLowerCase(), "arks-shop-app"],
      popOut: true,
      template: `modules/${MODULE_ID}/templates/shop-shell.hbs`,
      width: 960,
      height: 720,
      resizable: true,
      title: game.i18n.localize("ARKSSHOP.Title")
    });
  }

  async getData() {
    const characters = getAvailableCharacters();
    this.selectedActorId = getDefaultActorId(characters, this.selectedActorId);

    const selectedActor = characters.find((actor) => actor.id === this.selectedActorId) ?? null;
    const selectedActorGold = selectedActor ? selectedActor.getTotalMoneyGC() : 0;
    const selectedPacks = getSelectedEquipmentPacks();
    const items = await getShopInventory();
    const typeKeys = [...new Set(items.map((item) => item.type))];

    this.#syncToggleFilters("compendiums", selectedPacks.map((pack) => pack.collection), this.compendiumFilters);
    this.#syncToggleFilters("types", typeKeys, this.typeFilters);

    return {
      searchTerm: this.searchTerm,
      hasCharacters: characters.length > 0,
      characters: characters.map((actor) => ({
        id: actor.id,
        name: actor.name,
        selected: actor.id === this.selectedActorId
      })),
      selectedActorGold: formatGp(selectedActorGold),
      compendiumFilters: selectedPacks.map((pack) => ({
        id: pack.collection,
        label: pack.metadata.label,
        active: this.compendiumFilters.has(pack.collection)
      })),
      availabilityFilters: [
        {
          id: "all",
          label: game.i18n.localize("ARKSSHOP.Filters.All"),
          active: this.availabilityFilter === "all"
        },
        {
          id: "available",
          label: game.i18n.localize("ARKSSHOP.Filters.Available"),
          active: this.availabilityFilter === "available"
        },
        {
          id: "unavailable",
          label: game.i18n.localize("ARKSSHOP.Filters.Unavailable"),
          active: this.availabilityFilter === "unavailable"
        }
      ],
      typeFilters: typeKeys.map((type) => ({
        id: type,
        label: getTypeLabel(type),
        active: this.typeFilters.has(type)
      })),
      hasItems: items.length > 0,
      items: items.map((item) => ({
        ...item,
        priceCopper: gpToCopper(item.priceGp),
        formattedPrice: formatGp(item.priceGp),
        canPurchase: selectedActor ? selectedActorGold >= item.priceGp : false,
        hasMasterworkOptions: item.masterworkOptions.length > 0
      }))
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("select[name='actorId']").on("change", (event) => {
      this.selectedActorId = event.currentTarget.value;
      this.render(false);
    });

    html.find("input[name='search']").on("input", (event) => {
      this.searchTerm = event.currentTarget.value.trim().toLowerCase();
      this.#applyItemFilters(html);
    });

    html.find("[data-action='toggle-filter']").on("click", this.#onToggleFilter.bind(this));
    html.find("[data-action='buy-item']").on("click", this.#onBuyItem.bind(this));
    html.find("[data-action='open-source']").on("click", this.#onOpenSource.bind(this));
    html.find("input[name='quantity']").on("input change", this.#onPurchaseInputChange.bind(this, html));
    html.find("select[name='masterwork']").on("change", this.#onPurchaseInputChange.bind(this, html));

    this.#refreshPurchaseState(html);
    this.#applyItemFilters(html);
  }

  #syncToggleFilters(key, values, activeSet) {
    if (!this.#filtersInitialized[key]) {
      values.forEach((value) => activeSet.add(value));
      values.forEach((value) => this.#knownFilterValues[key].add(value));
      this.#filtersInitialized[key] = true;
      return;
    }

    const validValues = new Set(values);
    for (const value of [...activeSet]) {
      if (!validValues.has(value)) activeSet.delete(value);
    }

    for (const value of values) {
      if (!this.#knownFilterValues[key].has(value)) {
        activeSet.add(value);
        this.#knownFilterValues[key].add(value);
      }
    }
  }

  #applyItemFilters(html) {
    html.find(".arks-shop-item").each((_, element) => {
      const searchIndex = element.dataset.search ?? "";
      const compendiumMatch = this.compendiumFilters.has(element.dataset.compendium);
      const typeMatch = this.typeFilters.has(element.dataset.itemType);
      const availabilityMatch =
        this.availabilityFilter === "all" ||
        (this.availabilityFilter === "available" && element.dataset.canPurchase === "true") ||
        (this.availabilityFilter === "unavailable" && element.dataset.canPurchase === "false");
      const searchMatch = !this.searchTerm || searchIndex.includes(this.searchTerm);
      const matches = compendiumMatch && typeMatch && availabilityMatch && searchMatch;
      element.style.display = matches ? "" : "none";
    });
  }

  #onPurchaseInputChange(html) {
    this.#refreshPurchaseState(html);
    this.#applyItemFilters(html);
  }

  #refreshPurchaseState(html) {
    const root = getRootElement(html);
    if (!root) return;

    const selectedActor = getAvailableCharacters().find((actor) => actor.id === this.selectedActorId) ?? null;
    const availableCopper = selectedActor ? gpToCopper(selectedActor.getTotalMoneyGC()) : 0;

    root.querySelectorAll(".arks-shop-item").forEach((row) => {
      this.#refreshPurchaseRow(row, availableCopper, Boolean(selectedActor));
    });
  }

  #refreshPurchaseRow(row, availableCopper, hasActor) {
    const priceCopper = getRowUnitPriceCopper(row);
    const quantity = Math.max(1, Number.parseInt(row.querySelector("input[name='quantity']")?.value ?? "1", 10) || 1);
    const totalCopper = priceCopper * quantity;
    const canPurchase = hasActor && availableCopper >= totalCopper;
    const priceElement = row.querySelector("[data-role='item-price']");
    const summaryElement = row.querySelector("[data-role='masterwork-summary']");
    const selectedOption = row.querySelector("select[name='masterwork'] option:checked");
    const summary = selectedOption?.dataset.summary?.trim() ?? "";

    row.dataset.canPurchase = canPurchase ? "true" : "false";

    if (priceElement) priceElement.textContent = `${formatGp(priceCopper / 100)} gp`;
    if (summaryElement) summaryElement.textContent = summary;

    const buyButton = row.querySelector("[data-action='buy-item']");
    if (buyButton) buyButton.disabled = !canPurchase;
  }

  #onToggleFilter(event) {
    event.preventDefault();

    const { filterGroup, filterId } = event.currentTarget.dataset;
    if (!filterGroup || !filterId) return;

    if (filterGroup === "availability") {
      this.availabilityFilter = filterId;
    } else if (filterGroup === "compendium") {
      if (this.compendiumFilters.has(filterId)) this.compendiumFilters.delete(filterId);
      else this.compendiumFilters.add(filterId);
    } else if (filterGroup === "type") {
      if (this.typeFilters.has(filterId)) this.typeFilters.delete(filterId);
      else this.typeFilters.add(filterId);
    }

    this.render(false);
  }

  async #onOpenSource(event) {
    event.preventDefault();

    const itemUuid = event.currentTarget.closest("[data-item-uuid]")?.dataset.itemUuid;
    if (!itemUuid) return;

    const item = await fromUuid(itemUuid);
    item?.sheet?.render(true);
  }

  async #onBuyItem(event) {
    event.preventDefault();

    const row = event.currentTarget.closest("[data-item-uuid]");
    if (!row) return;

    const quantity = Math.max(1, Number.parseInt(row.querySelector("input[name='quantity']")?.value ?? "1", 10) || 1);
    const masterworkId = row.querySelector("select[name='masterwork']")?.value ?? "";

    try {
      await purchaseShopItem({
        actorId: this.selectedActorId,
        itemUuid: row.dataset.itemUuid,
        quantity,
        masterworkId
      });
      this.render(false);
    } catch (error) {
      console.error(`${MODULE_ID} | Purchase failed`, error);
      ui.notifications.error(error.message ?? game.i18n.localize("ARKSSHOP.Errors.PurchaseFailed"));
    }
  }
}

class ArksShopCompendiumSettingsForm extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-compendium-settings`,
      title: game.i18n.localize("ARKSSHOP.Settings.Compendiums.MenuLabel"),
      template: `modules/${MODULE_ID}/templates/settings-compendiums.hbs`,
      width: 520,
      height: "auto",
      closeOnSubmit: true
    });
  }

  getData() {
    const selected = new Set(game.settings.get(MODULE_ID, EQUIPMENT_COMPENDIUM_SETTING) ?? []);

    return {
      compendiums: getEligibleEquipmentPacks().map((pack) => ({
        fieldId: pack.collection.replaceAll(".", "__"),
        collection: pack.collection,
        label: pack.metadata.label,
        packageName: pack.metadata.packageName,
        checked: selected.has(pack.collection)
      }))
    };
  }

  async _updateObject(event) {
    const form = event.target;
    const selected = Array.from(form.querySelectorAll("input[name='compendiums']:checked"))
      .map((input) => input.value)
      .sort();

    await game.settings.set(MODULE_ID, EQUIPMENT_COMPENDIUM_SETTING, selected);
  }
}

class ArksSplitCostsApp extends FormApplication {
  constructor(options = {}) {
    super(options);
    this.totalCost = options.totalCost ?? "";
    this.selectedActors = new Set(options.actorIds ?? []);
    this.contributions = foundry.utils.deepClone(options.contributions ?? {});
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-split-costs`,
      title: game.i18n.localize("ARKSSHOP.SplitCosts.Title"),
      template: `modules/${MODULE_ID}/templates/split-costs.hbs`,
      width: 680,
      height: "auto",
      closeOnSubmit: true
    });
  }

  getData() {
    const characters = getAvailableCharacters();

    return {
      totalCost: this.totalCost,
      hasCharacters: characters.length > 0,
      characters: characters.map((actor) => ({
        id: actor.id,
        name: actor.name,
        selected: this.selectedActors.has(actor.id),
        contribution: this.contributions[actor.id] ?? "",
        availableGold: formatGp(actor.getTotalMoneyGC()),
        availableCopper: gpToCopper(actor.getTotalMoneyGC())
      }))
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    const refresh = this.#refreshState.bind(this, html);
    html.find("input[name='totalCost']").on("input change", refresh);
    html.find("[data-role='actor-toggle']").on("change", refresh);
    html.find("[data-role='contribution']").on("input change", refresh);
    html.find("[data-action='split-even']").on("click", this.#onSplitEven.bind(this));

    refresh();
  }

  #refreshState(html) {
    const root = html[0] ?? html;
    if (!root) return;

    const totalCostCopper = parseGpInput(root.querySelector("input[name='totalCost']")?.value);
    let assignedCopper = 0;
    let selectedCount = 0;
    let hasOverdrawnActor = false;

    root.querySelectorAll(".arks-split-costs__row").forEach((row) => {
      const toggle = row.querySelector("[data-role='actor-toggle']");
      const input = row.querySelector("[data-role='contribution']");
      const availableCopper = Number(row.dataset.availableCopper ?? 0);
      const selected = Boolean(toggle?.checked);
      const contributionCopper = selected ? parseGpInput(input?.value) : 0;
      const isOverdrawn = selected && contributionCopper > availableCopper;

      if (input) input.disabled = !selected;
      row.classList.toggle("is-selected", selected);
      row.classList.toggle("is-overdrawn", isOverdrawn);

      if (selected) {
        assignedCopper += contributionCopper;
        selectedCount += 1;
      }
      if (isOverdrawn) hasOverdrawnActor = true;
    });

    const remainingCopper = totalCostCopper - assignedCopper;
    const assignedElement = root.querySelector("[data-role='assigned-total']");
    const remainingElement = root.querySelector("[data-role='remaining-total']");
    const submitButton = root.querySelector("button[type='submit']");

    if (assignedElement) assignedElement.textContent = `${formatGp(assignedCopper / 100)} gp`;
    if (remainingElement) {
      remainingElement.textContent = `${formatGp(remainingCopper / 100)} gp`;
      remainingElement.classList.toggle("is-clear", remainingCopper === 0);
      remainingElement.classList.toggle("is-short", remainingCopper > 0);
      remainingElement.classList.toggle("is-over", remainingCopper < 0);
    }

    if (submitButton) {
      submitButton.disabled = totalCostCopper <= 0 || selectedCount === 0 || remainingCopper !== 0 || hasOverdrawnActor;
    }
  }

  #onSplitEven(event) {
    event.preventDefault();

    const form = this.form;
    if (!form) return;

    const totalCostCopper = parseGpInput(form.querySelector("input[name='totalCost']")?.value);
    if (totalCostCopper <= 0) {
      ui.notifications.error(game.i18n.localize("ARKSSHOP.SplitCosts.Errors.InvalidTotal"));
      return;
    }

    const selectedRows = [];
    let lockedCopper = 0;

    for (const row of form.querySelectorAll(".arks-split-costs__row")) {
      const toggle = row.querySelector("[data-role='actor-toggle']");
      const input = row.querySelector("[data-role='contribution']");
      if (!toggle?.checked || !input) continue;

      const contributionCopper = parseGpInput(input.value);
      const isLocked = contributionCopper > 0;

      selectedRows.push({ input, isLocked, contributionCopper });
      if (isLocked) lockedCopper += contributionCopper;
    }

    if (!selectedRows.length) {
      ui.notifications.error(game.i18n.localize("ARKSSHOP.SplitCosts.Errors.NoPool"));
      return;
    }

    if (lockedCopper > totalCostCopper) {
      ui.notifications.error(game.i18n.localize("ARKSSHOP.SplitCosts.Errors.LockedTooHigh"));
      return;
    }

    const remainingCopper = totalCostCopper - lockedCopper;
    const adjustableRows = selectedRows.filter((row) => !row.isLocked);

    if (!adjustableRows.length) {
      if (remainingCopper > 0) {
        ui.notifications.warn(game.i18n.localize("ARKSSHOP.SplitCosts.Errors.NoAdjustableActors"));
      }
      this.#refreshState(form);
      return;
    }

    const baseShare = Math.floor(remainingCopper / adjustableRows.length);
    let remainderCopper = remainingCopper - baseShare * adjustableRows.length;

    adjustableRows.forEach((row) => {
      const shareCopper = baseShare + (remainderCopper > 0 ? 1 : 0);
      if (remainderCopper > 0) remainderCopper -= 1;
      row.input.value = formatGp(shareCopper / 100);
    });

    this.#refreshState(form);
  }

  async _updateObject() {
    const form = this.form;
    if (!form) return;

    const totalCostCopper = parseGpInput(form.querySelector("input[name='totalCost']")?.value);
    const selections = [];
    let assignedCopper = 0;

    for (const row of form.querySelectorAll(".arks-split-costs__row")) {
      const toggle = row.querySelector("[data-role='actor-toggle']");
      const input = row.querySelector("[data-role='contribution']");
      if (!toggle?.checked) continue;

      const actorId = row.dataset.actorId;
      const contributionCopper = parseGpInput(input?.value);
      selections.push({ actorId, contributionCopper });
      assignedCopper += contributionCopper;
    }

    if (totalCostCopper <= 0) {
      notifyAndThrow(game.i18n.localize("ARKSSHOP.SplitCosts.Errors.InvalidTotal"));
    }

    if (!selections.length) {
      notifyAndThrow(game.i18n.localize("ARKSSHOP.SplitCosts.Errors.NoPool"));
    }

    if (assignedCopper !== totalCostCopper) {
      notifyAndThrow(game.i18n.localize("ARKSSHOP.SplitCosts.Errors.TotalMismatch"));
    }

    const paidBy = [];
    for (const selection of selections) {
      if (selection.contributionCopper <= 0) continue;

      const actor = game.actors.get(selection.actorId);
      if (!actor || actor.type !== "character" || (!game.user.isGM && !actor.isOwner)) {
        notifyAndThrow(game.i18n.localize("ARKSSHOP.SplitCosts.Errors.InvalidActor"));
      }

      const contributionGp = selection.contributionCopper / 100;
      if (actor.getTotalMoneyGC() < contributionGp) {
        notifyAndThrow(
          game.i18n.format("ARKSSHOP.SplitCosts.Errors.NotEnoughGold", {
            actor: actor.name,
            cost: formatGp(contributionGp)
          })
        );
      }

      await deductActorMoney(actor, contributionGp);
      paidBy.push({ actor, contributionGp });
    }

    if (!paidBy.length) {
      notifyAndThrow(game.i18n.localize("ARKSSHOP.SplitCosts.Errors.NoPayments"));
    }

    await createSplitCostsChatMessage(totalCostCopper / 100, paidBy);
    ui.notifications.info(
      game.i18n.format("ARKSSHOP.SplitCosts.Messages.Applied", {
        total: formatGp(totalCostCopper / 100)
      })
    );
  }
}

function notifyAndThrow(message) {
  ui.notifications.error(message);
  throw new Error(message);
}

function isEligibleEquipmentPack(pack) {
  if (pack.documentName !== "Item") return false;

  const metadataFields = [pack.collection, pack.metadata.label, pack.metadata.name];
  return metadataFields.some((value) => EQUIPMENT_PACK_PATTERN.test(value ?? ""));
}

function getEligibleEquipmentPacks() {
  return game.packs.contents
    .filter(isEligibleEquipmentPack)
    .sort((a, b) => a.metadata.label.localeCompare(b.metadata.label));
}

function getSelectedEquipmentPackIds() {
  const selected = game.settings.get(MODULE_ID, EQUIPMENT_COMPENDIUM_SETTING) ?? [];
  const validIds = new Set(getEligibleEquipmentPacks().map((pack) => pack.collection));
  return selected.filter((collection) => validIds.has(collection));
}

function getSelectedEquipmentPacks() {
  const selected = new Set(getSelectedEquipmentPackIds());
  return getEligibleEquipmentPacks().filter((pack) => selected.has(pack.collection));
}

function getSelectedPackLabels() {
  return getSelectedEquipmentPacks().map((pack) => pack.metadata.label);
}

function getAvailableCharacters() {
  const characters = game.actors.contents
    .filter((actor) => actor.type === "character" && (game.user.isGM || actor.isOwner))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (game.user.character?.type === "character") {
    characters.sort((left, right) => {
      if (left.id === game.user.character.id) return -1;
      if (right.id === game.user.character.id) return 1;
      return left.name.localeCompare(right.name);
    });
  }

  return characters;
}

function getDefaultActorId(characters, preferredActorId) {
  if (characters.some((actor) => actor.id === preferredActorId)) return preferredActorId;
  if (game.user.character && characters.some((actor) => actor.id === game.user.character.id)) return game.user.character.id;
  return characters[0]?.id ?? "";
}

function getTypeLabel(type) {
  const label = game.i18n.localize(`ARKSSHOP.ItemTypes.${type}`);
  return label.startsWith("ARKSSHOP.") ? type : label;
}

function stripHtml(value) {
  return `${value ?? ""}`.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function isInstrumentItem(item) {
  if (item?.type !== "item") return false;

  const searchText = [item.name, item.system?.subtype, item.system?.description]
    .map((value) => stripHtml(value))
    .join(" ");

  return INSTRUMENT_ITEM_PATTERN.test(searchText);
}

function getMasterworkOptions(item) {
  if (item?.type === "weapon") {
    return [
      createMasterworkOption("weapon-hit", 80, "WeaponHit", "WeaponHitName", "WeaponHitSummary"),
      createMasterworkOption("weapon-damage", 80, "WeaponDamage", "WeaponDamageName", "WeaponDamageSummary"),
      createMasterworkOption("weapon-both", 650, "WeaponBoth", "WeaponBothName", "WeaponBothSummary")
    ];
  }

  if (item?.type === "armor") {
    return [
      createMasterworkOption("armor-light", 80, "ArmorLight", "ArmorLightName", "ArmorLightSummary"),
      createMasterworkOption("armor-ac", 650, "ArmorAc", "ArmorAcName", "ArmorAcSummary")
    ];
  }

  if (isInstrumentItem(item)) {
    return [
      createMasterworkOption("instrument-perf-1", 80, "InstrumentOne", "InstrumentOneName", "InstrumentOneSummary"),
      createMasterworkOption("instrument-perf-2", 650, "InstrumentTwo", "InstrumentTwoName", "InstrumentTwoSummary")
    ];
  }

  return [];
}

function createMasterworkOption(id, priceDeltaGp, labelKey, nameKey, summaryKey) {
  return {
    id,
    label: game.i18n.format(`ARKSSHOP.Masterwork.Options.${labelKey}`, {
      price: formatGp(priceDeltaGp)
    }),
    nameLabel: game.i18n.localize(`ARKSSHOP.Masterwork.Options.${nameKey}`),
    summary: game.i18n.localize(`ARKSSHOP.Masterwork.Options.${summaryKey}`),
    priceDeltaGp,
    priceDeltaCopper: gpToCopper(priceDeltaGp)
  };
}

function getMasterworkOption(item, masterworkId) {
  if (!masterworkId) return null;
  return getMasterworkOptions(item).find((option) => option.id === masterworkId) ?? null;
}

function getItemCost(item) {
  const cost = Number(item.system?.cost ?? 0);
  return Number.isFinite(cost) ? cost : 0;
}

function getMasterworkAdjustedCost(item, masterworkOption) {
  return getItemCost(item) + Number(masterworkOption?.priceDeltaGp ?? 0);
}

function formatGp(value) {
  const rounded = (Math.round(Number(value) * 100) / 100).toFixed(2);
  return rounded.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function parseGpInput(value) {
  const parsed = Number.parseFloat(`${value ?? ""}`.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return gpToCopper(parsed);
}

function gpToCopper(value) {
  return Math.round(Number(value) * 100);
}

function getRowUnitPriceCopper(row) {
  const basePriceCopper = Number(row?.dataset.basePriceCopper ?? 0);
  const selectedOption = row?.querySelector("select[name='masterwork'] option:checked");
  const adjustmentCopper = Number(selectedOption?.dataset.priceAdjustmentCopper ?? 0);
  return basePriceCopper + adjustmentCopper;
}

function getNumericPropertyValue(data, path, fallback = 0) {
  const value = foundry.utils.getProperty(data, path);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function setBestNumericProperty(data, paths, delta, fallback = 0) {
  for (const path of paths) {
    if (foundry.utils.hasProperty(data, path)) {
      const currentValue = getNumericPropertyValue(data, path, fallback);
      foundry.utils.setProperty(data, path, currentValue + delta);
      return;
    }
  }
}

function getWeight6Value(itemData) {
  const explicitWeight6 = getNumericPropertyValue(itemData, "system.weight6", -1);
  if (explicitWeight6 >= 0) return explicitWeight6;

  const legacyWeight = getNumericPropertyValue(itemData, "system.weight", -1);
  if (legacyWeight >= 0) return Math.floor(legacyWeight / 166.66);

  return 0;
}

function applyFlatBonusToFormula(formula, bonus) {
  const trimmed = `${formula ?? ""}`.trim();
  if (!trimmed) return `${bonus}`;
  return `${trimmed} + ${bonus}`;
}

function buildMasterworkName(itemName, masterworkOption) {
  if (!masterworkOption) return itemName;
  return `${itemName} (${masterworkOption.nameLabel})`;
}

function appendMasterworkDescription(description, masterworkOption) {
  if (!masterworkOption) return description ?? "";

  const currentDescription = `${description ?? ""}`.trim();
  const note = `<p><strong>${game.i18n.localize("ARKSSHOP.Masterwork.NoteLabel")}:</strong> ${masterworkOption.summary}</p>`;
  return currentDescription ? `${currentDescription}${note}` : note;
}

function getMoneyItems(actor) {
  return actor.items
    .filter((item) => item.type === "money" && Number(item.system.coppervalue) > 0)
    .sort((a, b) => Number(b.system.coppervalue) - Number(a.system.coppervalue));
}

function resetShopInventoryCache() {
  shopInventoryCache = [];
  shopInventoryCacheKey = "";

  if (shopApp?.rendered) {
    shopApp.render(false);
  }
}

async function ensureDefaultEquipmentCompendiums() {
  if (!game.user.isGM) return;
  if (game.settings.get(MODULE_ID, EQUIPMENT_COMPENDIUMS_INITIALIZED_SETTING)) return;

  const defaults = getEligibleEquipmentPacks().map((pack) => pack.collection);
  await game.settings.set(MODULE_ID, EQUIPMENT_COMPENDIUM_SETTING, defaults);
  await game.settings.set(MODULE_ID, EQUIPMENT_COMPENDIUMS_INITIALIZED_SETTING, true);
}

async function getShopInventory() {
  const selectedPackIds = getSelectedEquipmentPackIds();
  const cacheKey = selectedPackIds.join("|");

  if (cacheKey === shopInventoryCacheKey) {
    return shopInventoryCache;
  }

  const inventory = [];

  for (const collection of selectedPackIds) {
    const pack = game.packs.get(collection);
    if (!pack) continue;
    if (!game.user.isGM && pack.visible === false) continue;

    try {
      const documents = await pack.getDocuments();

      for (const document of documents) {
        if (!SELLABLE_ITEM_TYPES.has(document.type)) continue;

        const masterworkOptions = getMasterworkOptions(document);

        inventory.push({
          uuid: document.uuid,
          name: document.name,
          img: document.img,
          type: document.type,
          typeLabel: getTypeLabel(document.type),
          sourceCollection: pack.collection,
          sourceLabel: pack.metadata.label,
          priceGp: getItemCost(document),
          masterworkOptions,
          searchText: `${document.name} ${pack.metadata.label} ${document.type}`.toLowerCase()
        });
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to load shop compendium ${collection}`, error);
    }
  }

  inventory.sort((left, right) => {
    if (left.type !== right.type) return left.type.localeCompare(right.type);
    return left.name.localeCompare(right.name);
  });

  shopInventoryCache = inventory;
  shopInventoryCacheKey = cacheKey;

  return inventory;
}

function applyMasterworkToItemData(itemData, masterworkOption) {
  if (!masterworkOption) return itemData;

  itemData.name = buildMasterworkName(itemData.name, masterworkOption);
  itemData.flags ??= {};
  itemData.flags[MODULE_ID] = {
    ...(itemData.flags[MODULE_ID] ?? {}),
    masterwork: {
      id: masterworkOption.id,
      label: masterworkOption.nameLabel,
      summary: masterworkOption.summary,
      priceDeltaGp: masterworkOption.priceDeltaGp
    }
  };

  if (foundry.utils.hasProperty(itemData, "system.cost")) {
    const baseCost = getNumericPropertyValue(itemData, "system.cost", 0);
    foundry.utils.setProperty(itemData, "system.cost", baseCost + masterworkOption.priceDeltaGp);
  }

  if (foundry.utils.hasProperty(itemData, "system.description")) {
    foundry.utils.setProperty(
      itemData,
      "system.description",
      appendMasterworkDescription(foundry.utils.getProperty(itemData, "system.description"), masterworkOption)
    );
  }

  switch (masterworkOption.id) {
    case "weapon-hit":
      setBestNumericProperty(itemData, ["system.bonus"], 1, 0);
      break;
    case "weapon-damage":
      foundry.utils.setProperty(
        itemData,
        "system.damage",
        applyFlatBonusToFormula(foundry.utils.getProperty(itemData, "system.damage"), 1)
      );
      break;
    case "weapon-both":
      setBestNumericProperty(itemData, ["system.bonus"], 1, 0);
      foundry.utils.setProperty(
        itemData,
        "system.damage",
        applyFlatBonusToFormula(foundry.utils.getProperty(itemData, "system.damage"), 1)
      );
      break;
    case "armor-light": {
      const weight6 = getWeight6Value(itemData);
      foundry.utils.setProperty(itemData, "system.weight6", weight6 <= 6 ? 1 : Math.max(0, weight6 - 6));
      break;
    }
    case "armor-ac":
      setBestNumericProperty(itemData, ["system.aac.value", "system.aac"], 1, 0);
      setBestNumericProperty(itemData, ["system.ac.value", "system.ac"], -1, 9);
      break;
    case "instrument-perf-1":
    case "instrument-perf-2":
      break;
  }

  return itemData;
}

function prepareOwnedItemData(sourceItem, masterworkOption = null) {
  const itemData = foundry.utils.deepClone(sourceItem.toObject());

  delete itemData._id;
  delete itemData.folder;
  delete itemData.pack;
  delete itemData.sort;

  if (itemData.system?.hasOwnProperty("equipped")) itemData.system.equipped = false;
  if (itemData.system?.hasOwnProperty("favorite")) itemData.system.favorite = false;
  if (itemData.system?.quantity?.value != null) itemData.system.quantity.value = 1;

  return applyMasterworkToItemData(itemData, masterworkOption);
}

async function deductActorMoney(actor, totalPriceGp) {
  const costInCopper = gpToCopper(totalPriceGp);
  if (costInCopper <= 0) return;

  const moneyItems = getMoneyItems(actor);
  let remainingCopper = moneyItems.reduce(
    (total, item) => total + Number(item.system.quantity ?? 0) * Number(item.system.coppervalue ?? 0),
    0
  );

  if (remainingCopper < costInCopper) {
    throw new Error(game.i18n.localize("ARKSSHOP.Errors.NotEnoughGold"));
  }

  remainingCopper -= costInCopper;

  const updates = [];
  for (const moneyItem of moneyItems) {
    const coinValue = Number(moneyItem.system.coppervalue);
    const newQuantity = Math.floor(remainingCopper / coinValue);
    remainingCopper -= newQuantity * coinValue;

    if (newQuantity !== Number(moneyItem.system.quantity)) {
      updates.push({
        _id: moneyItem.id,
        "system.quantity": newQuantity
      });
    }
  }

  if (remainingCopper > 0) {
    throw new Error(game.i18n.localize("ARKSSHOP.Errors.CannotMakeChange"));
  }

  if (updates.length) {
    await actor.updateEmbeddedDocuments("Item", updates);
  }
}

async function addPurchasedItems(actor, itemData, quantity) {
  if (itemData.type === "item") {
    const existing = actor.items.find(
      (item) =>
        item.type === "item" &&
        item.name === itemData.name &&
        (item.system.subtype ?? "") === (itemData.system.subtype ?? "")
    );

    if (existing) {
      const currentQuantity = Number(existing.system.quantity?.value ?? 1);
      await existing.update({ "system.quantity.value": currentQuantity + quantity });
      return;
    }
  }

  const documents = Array.from({ length: quantity }, () => foundry.utils.deepClone(itemData));

  if (itemData.type === "item") {
    documents[0].system.quantity.value = quantity;
    await actor.createEmbeddedDocuments("Item", [documents[0]]);
    return;
  }

  await actor.createEmbeddedDocuments("Item", documents);
}

async function createPurchaseChatMessage(actor, itemName, quantity, totalPriceGp) {
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: game.i18n.format("ARKSSHOP.Messages.Purchase", {
      actor: actor.name,
      quantity,
      item: itemName,
      cost: formatGp(totalPriceGp)
    })
  });
}

async function createSplitCostsChatMessage(totalCostGp, paidBy) {
  const rows = paidBy
    .map(({ actor, contributionGp }) => `<li><strong>${actor.name}</strong>: ${formatGp(contributionGp)} gp</li>`)
    .join("");

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: `
      <p>${game.i18n.format("ARKSSHOP.SplitCosts.Messages.ChatIntro", {
        total: formatGp(totalCostGp)
      })}</p>
      <ul>${rows}</ul>
    `
  });
}

async function purchaseShopItem({ actorId, itemUuid, quantity, masterworkId = "" }) {
  const actor = game.actors.get(actorId);
  if (!actorId || !actor || actor.type !== "character" || (!game.user.isGM && !actor.isOwner)) {
    throw new Error(game.i18n.localize("ARKSSHOP.Errors.NoCharacter"));
  }

  const shopItem = await fromUuid(itemUuid);
  if (!(shopItem instanceof Item) || !SELLABLE_ITEM_TYPES.has(shopItem.type)) {
    throw new Error(game.i18n.localize("ARKSSHOP.Errors.InvalidItem"));
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(game.i18n.localize("ARKSSHOP.Errors.InvalidQuantity"));
  }

  const masterworkOption = getMasterworkOption(shopItem, masterworkId);
  if (masterworkId && !masterworkOption) {
    throw new Error(game.i18n.localize("ARKSSHOP.Errors.InvalidMasterwork"));
  }

  const purchasedItemData = prepareOwnedItemData(shopItem, masterworkOption);
  const totalPriceGp = getMasterworkAdjustedCost(shopItem, masterworkOption) * quantity;
  if (actor.getTotalMoneyGC() < totalPriceGp) {
    throw new Error(
      game.i18n.format("ARKSSHOP.Errors.NotEnoughGoldForItem", {
        actor: actor.name,
        quantity,
        item: purchasedItemData.name,
        cost: formatGp(totalPriceGp)
      })
    );
  }

  await deductActorMoney(actor, totalPriceGp);
  await addPurchasedItems(actor, purchasedItemData, quantity);
  await createPurchaseChatMessage(actor, purchasedItemData.name, quantity, totalPriceGp);

  ui.notifications.info(
    game.i18n.format("ARKSSHOP.Messages.PurchaseNotice", {
      actor: actor.name,
      quantity,
      item: purchasedItemData.name,
      cost: formatGp(totalPriceGp)
    })
  );
}

function registerSettings() {
  game.settings.register(MODULE_ID, "showActorsDirectoryButton", {
    name: "ARKSSHOP.Settings.ShowButton.Name",
    hint: "ARKSSHOP.Settings.ShowButton.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.registerMenu(MODULE_ID, "equipmentCompendiumsMenu", {
    name: "ARKSSHOP.Settings.Compendiums.MenuLabel",
    label: "ARKSSHOP.Settings.Compendiums.MenuButton",
    hint: "ARKSSHOP.Settings.Compendiums.MenuHint",
    icon: "fas fa-book",
    type: ArksShopCompendiumSettingsForm,
    restricted: true
  });

  game.settings.register(MODULE_ID, EQUIPMENT_COMPENDIUM_SETTING, {
    name: "ARKSSHOP.Settings.Compendiums.Name",
    hint: "ARKSSHOP.Settings.Compendiums.Hint",
    scope: "world",
    config: false,
    type: Array,
    default: [],
    onChange: resetShopInventoryCache
  });

  game.settings.register(MODULE_ID, EQUIPMENT_COMPENDIUMS_INITIALIZED_SETTING, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });
}

function registerKeybindings() {
  game.keybindings.register(MODULE_ID, "openShop", {
    name: "ARKSSHOP.Keybindings.OpenShop.Name",
    hint: "ARKSSHOP.Keybindings.OpenShop.Hint",
    editable: [
      {
        key: "KeyS",
        modifiers: ["Shift"]
      }
    ],
    onDown: () => {
      game.ARKSShop.openShop();
      return true;
    },
    restricted: false
  });
}

function createApi() {
  return {
    openShop: (options = {}) => {
      if (!shopApp) {
        shopApp = new ArksShopApp(options);
      } else if (options.actorId) {
        shopApp.selectedActorId = options.actorId;
      }

      shopApp.render(true);
      return shopApp;
    },
    openSplitCosts: (options = {}) => {
      splitCostsApp?.close();
      splitCostsApp = new ArksSplitCostsApp(options);
      splitCostsApp.render(true);
      return splitCostsApp;
    },
    getSelectedEquipmentPacks,
    refreshInventory: resetShopInventoryCache
  };
}

function getRootElement(html) {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;
  return html[0] ?? null;
}

function ensureDirectoryFooter(root) {
  let footer = root.querySelector(".directory-footer");
  if (footer) return footer;

  footer = document.createElement("footer");
  footer.className = "directory-footer action-buttons flexrow";

  const directoryList = root.querySelector(".directory-list");
  if (directoryList?.parentElement) {
    directoryList.insertAdjacentElement("afterend", footer);
  } else {
    root.appendChild(footer);
  }

  return footer;
}

function addDirectoryButton(app, html) {
  const isItemDirectory =
    app?.options?.id === ITEM_DIRECTORY_ID ||
    app?.documentName === "Item" ||
    app?.constructor?.name === "ItemDirectory";

  if (!isItemDirectory) return;
  if (!game.settings.get(MODULE_ID, "showActorsDirectoryButton")) return;

  const root = getRootElement(html);
  if (!root) return;

  const footer = ensureDirectoryFooter(root);
  const buttonConfigs = [
    {
      className: `${MODULE_ID}-open-shop`,
      icon: "fas fa-store",
      label: game.i18n.localize("ARKSSHOP.OpenShop"),
      onClick: () => game.ARKSShop.openShop()
    },
    {
      className: `${MODULE_ID}-split-costs`,
      icon: "fas fa-coins",
      label: game.i18n.localize("ARKSSHOP.SplitCosts.Button"),
      onClick: () => game.ARKSShop.openSplitCosts()
    }
  ];

  for (const config of buttonConfigs) {
    if (root.querySelector(`.${config.className}`)) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = config.className;
    button.innerHTML = `<i class="${config.icon}"></i> ${config.label}`;
    button.addEventListener("click", config.onClick);
    footer.appendChild(button);
  }
}

Hooks.once("init", async () => {
  console.log(`${MODULE_ID} | Initializing module`);
  registerSettings();
  registerKeybindings();
  game.ARKSShop = createApi();

  await loadTemplates([
    `modules/${MODULE_ID}/templates/shop-shell.hbs`,
    `modules/${MODULE_ID}/templates/settings-compendiums.hbs`,
    `modules/${MODULE_ID}/templates/split-costs.hbs`
  ]);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);
  void ensureDefaultEquipmentCompendiums().then(() => resetShopInventoryCache());
});

Hooks.on("renderSidebarTab", (app, html) => {
  addDirectoryButton(app, html);
});

Hooks.on("renderItemDirectory", (app, html) => {
  addDirectoryButton(app, html);
});
