/**
 * DDB AI Compendium Translator
 * Module pour traduire les compendiums DDB en français via IA (OpenAI / Gemini).
 */

const MODULE_ID = "ddb-ai-compendium-translator";

// --- Settings Definitions ---
Hooks.once('init', () => {
    console.log(`${MODULE_ID} | Initializing...`);

    game.settings.register(MODULE_ID, "apiProvider", {
        name: "Fournisseur IA",
        hint: "Choisissez l'API à utiliser.",
        scope: "world",
        config: true,
        type: String,
        choices: {
            "openai": "OpenAI",
            "gemini": "Google Gemini"
        },
        default: "openai"
    });

    game.settings.register(MODULE_ID, "apiKey", {
        name: "Clé API",
        hint: "Votre clé API (OpenAI sk-... ou Gemini AIza...).",
        scope: "world",
        config: true,
        type: String,
        default: "",
        onChange: () => location.reload() // Reload to ensure key is picked up if needed, though not strictly necessary.
    });

    game.settings.register(MODULE_ID, "model", {
        name: "Modèle IA",
        hint: "Ex: gpt-4o-mini (OpenAI) ou gemini-1.5-flash (Gemini).",
        scope: "world",
        config: true,
        type: String,
        default: "gpt-4o-mini"
    });

    game.settings.register(MODULE_ID, "prompt", {
        name: "Prompt Système",
        hint: "Instructions données à l'IA. Gardez '[TEXTE]' à la fin.",
        scope: "world",
        config: true,
        type: String,
        default: `Tu es un traducteur expert de Donjons & Dragons 5e. Traduis le texte suivant en français fluide et immersif, en conservant absolument TOUTE la mise en forme HTML originale (ne modifie AUCUNE balise, garde-les intactes). Utilise les termes officiels français de D&D 5e : 'hit points' → 'points de vie', 'saving throw' → 'jet de sauvegarde', 'Armor Class' → 'classe d'armure', 'proficiency bonus' → 'bonus de maîtrise', 'spell slots' → 'emplacements de sorts', etc. Garde le ton narratif et les mécaniques intactes. Ne résume pas, n'ajoute pas de commentaires, traduis fidèlement le contenu fourni.\n\nTexte à traduire : [TEXTE]`
    });
});

// --- Context Menu Hook ---
Hooks.on('getCompendiumDirectoryEntryContext', (html, options) => {
    options.push({
        name: "Traduire en FR avec IA",
        icon: '<i class="fas fa-language"></i>',
        callback: (li) => {
            const packId = li.data("pack");
            const pack = game.packs.get(packId);
            if (!pack) return ui.notifications.error("Compendium introuvable.");
            CompendiumTranslator.translateCompendium(pack);
        }
    });
});

// --- Main Translator Class ---
class CompendiumTranslator {
    
    static async translateCompendium(sourcePack) {
        // 1. Checks
        const provider = game.settings.get(MODULE_ID, "apiProvider");
        const apiKey = game.settings.get(MODULE_ID, "apiKey");
        
        if (!apiKey) {
            return ui.notifications.error("Veuillez configurer la clé API dans les paramètres du module.");
        }

        if (sourcePack.locked) {
            // Usually we can't add to locked compendiums, but we are creating a NEW one so it's fine.
        }

        const sourceLabel = sourcePack.metadata.label;
        const targetLabel = `[FR] ${sourceLabel}`;
        const docType = sourcePack.metadata.type; // "Item", "Actor", "JournalEntry"

        ui.notifications.info(`Début de la traduction de ${sourceLabel}...`);

        // 2. Create Target Compendium
        // Foundry V12: CompendiumCollection.createCompendium({label, type, ...})
        // But we usually create it via the server side or check if exists.
        // Let's assume we create a NEW one each time or check existence.
        
        let targetPack = game.packs.find(p => p.metadata.label === targetLabel && p.metadata.type === docType);
        if (!targetPack) {
            try {
                // Determine package name logic or just allow system to auto-generate
                // In V12 we might use CompendiumCollection.createCompendium
                // Or simplified:
                targetPack = await CompendiumCollection.createCompendium({
                    label: targetLabel,
                    type: docType,
                    ownership: {PLAYER: "OBSERVER"} // Default visibility
                });
            } catch (e) {
                console.error(e);
                return ui.notifications.error("Erreur lors de la création du compendium de destination.");
            }
        }

        // 3. Get All Documents
        const documents = await sourcePack.getDocuments();
        const total = documents.length;
        if (total === 0) return ui.notifications.warn("Le compendium source est vide.");

        // 4. Batch Process
        const BATCH_SIZE = 5; // To avoid hitting rate limits too hard
        let processed = 0;
        
        // Progress Bar
        SceneNavigation.displayProgressBar({ label: "Traduction en cours...", pct: 0 });

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = documents.slice(i, i + BATCH_SIZE);
            
            // Validate batch promises
            const promises = batch.map(async (doc) => {
                try {
                    const translatedData = await this.translateDocument(doc);
                    // Create new doc in target pack
                    // Keep original image, usage, etc.
                    // Rename
                    const newName = `[FR] ${doc.name}`; // We technically translate content, maybe name too? Prompt says "NomOriginal" in request 
                    // Request says: "nom '[FR] NomOriginal', contenu traduit." 
                    // The core prompt translates "Texte suivant". We might want to translate the name too?
                    // "3. Traduit tous les documents... Envoie les contenus textuels... description, content... "
                    // Assuming we might want to keep name as [FR] OriginalName or Translate name?
                    // User said: "nom '[FR] NomOriginal'" in point 9. So keep original name with prefix.

                    const dataToCreate = {
                        ...translatedData,
                        name: `[FR] ${doc.name}`,
                        folder: null, // Don't copy folders for now as IDs won't match in new compendium easily without recreating folder structure.
                        sort: doc.sort
                    };

                    // Copy flags if needed, usually passed in creation data
                    // foundry.utils.mergeObject(dataToCreate, doc.toObject()) -> risky if we overwrite our translation.
                    
                    // Better approach: Get object, overwrite specific fields.
                    const sourceObj = doc.toObject();
                    delete sourceObj._id; 
                    delete sourceObj.pack;
                    delete sourceObj.folder; // Flatten structure for simplicity or implementing folder mapping is out of scope unless simple.
                    
                    // Merge translation
                    foundry.utils.mergeObject(sourceObj, dataToCreate);
                    sourceObj.name = `[FR] ${doc.name}`;

                    await targetPack.documentClass.create(sourceObj, { pack: targetPack.collection });
                } catch (err) {
                    console.error(`Erreur traduction doc ${doc.name}:`, err);
                    ui.notifications.error(`Erreur sur ${doc.name} (voir console)`);
                }
            });

            await Promise.all(promises);
            processed += batch.length;
            
            // Progress update
            const pct = Math.round((processed / total) * 100);
            SceneNavigation.displayProgressBar({ label: `Traduction... (${processed}/${total})`, pct: pct });

            // Rate limit wait
            await new Promise(r => setTimeout(r, 1000));
        }

        SceneNavigation.displayProgressBar({ label: "Traduction terminée !", pct: 100 });
        ui.notifications.info(`Compendium [FR] créé avec succès : ${targetLabel}`);
    }

    static async translateDocument(doc) {
        // Extract fields based on type
        // This assumes D&D 5e system structure largely.
        
        const updates = {};
        
        // Helper to translate string
        const translate = async (text) => {
            if (!text || typeof text !== 'string' || text.trim() === "") return text;
            return await this.callAI(text);
        };

        // 1. Entity: Item / Spell / Feature
        if (doc.documentName === "Item") {
            // system.description.value
            if (doc.system?.description?.value) {
                updates["system.description.value"] = await translate(doc.system.description.value);
            }
            // Add other fields if necessary? Chat flavor?
            // User asked for "description, content, etc."
            if (doc.system?.description?.chat) {
                updates["system.description.chat"] = await translate(doc.system.description.chat);
            }
        }
        
        // 2. Entity: JournalEntry
        else if (doc.documentName === "JournalEntry") {
            // Journals have pages.
            // We need to translate pages.
            // But we creating the Journal object. 
            // The `pages` are embedded.
            // We better translate the pages array in the sourceObj.
            
            // We can't return simple updates path for array of pages easily.
            // We will modify the sourceObj strategy in the caller? 
            // Or return a "pages" array update.
            
            const pagesConfig = [];
            const pages = doc.pages.contents; // Embedded collection
            
            for (const page of pages) {
                const pageObj = page.toObject();
                delete pageObj._id;
                
                // Translate page content based on type
                if (page.type === "text") {
                    if (page.text?.content) {
                        pageObj.text.content = await translate(page.text.content);
                    }
                }
                // Handle image pages caption?
                if (page.image?.caption) {
                    pageObj.image.caption = await translate(page.image.caption);
                }
                
                pagesConfig.push(pageObj);
            }
            updates["pages"] = pagesConfig; // Will replace pages in creation
        }
        
        // 3. Entity: Actor
        else if (doc.documentName === "Actor") {
            // system.details.biography.value
            if (doc.system?.details?.biography?.value) {
                updates["system.details.biography.value"] = await translate(doc.system.details.biography.value);
            }
            // NPC details?
            if (doc.type === "npc") {
                 // Legendary actions description?
            }
        }

        return updates;
    }

    static async callAI(text) {
        if (!text) return "";
        
        const provider = game.settings.get(MODULE_ID, "apiProvider");
        const apiKey = game.settings.get(MODULE_ID, "apiKey");
        const model = game.settings.get(MODULE_ID, "model"); // default gpt-4o-mini or gemini-1.5-flash
        const systemPrompt = game.settings.get(MODULE_ID, "prompt"); // Has "[TEXTE]" at end
        
        // Inject text into prompt. 
        // Note: OpenAI supports "messages" with "system" and "user". 
        // Gemini supports "contents".
        
        // Let's parse the user's prompt template.
        // It ends with "[TEXTE]" used as placeholder.
        const fullPrompt = systemPrompt.replace("[TEXTE]", text);
        
        // Rate limiting handled in batch loop (1s wait).
        
        try {
            if (provider === "openai") {
                const url = "https://api.openai.com/v1/chat/completions";
                const body = {
                    model: model || "gpt-4o-mini",
                    messages: [
                        { role: "system", content: systemPrompt.replace("Texte à traduire : [TEXTE]", "").trim() }, // Try to split system vs user if possible, or just send one block.
                        // Actually, better to just put everything in User if the prompt is one big block, 
                        // OR clean it up. The user provided a prompt that ENDS with the text.
                        // Let's use the provided prompt as the "User" message, or System + User.
                        // User's prompt: "Tu es un traducteur ... Texte à traduire : [TEXTE]"
                        // Simplify:
                        { role: "user", content: fullPrompt }
                    ],
                    temperature: 0.3
                };
                
                const response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${apiKey}`
                    },
                    body: JSON.stringify(body)
                });
                
                if (!response.ok) throw new Error(`OpenAI Error: ${response.statusText}`);
                const json = await response.json();
                return json.choices[0].message.content;

            } else if (provider === "gemini") {
                // https://generativelanguage.googleapis.com/v1/models/{model}:generateContent?key={apiKey}
                // Model needs to be e.g. "gemini-1.5-flash"
                const modelName = model || "gemini-1.5-flash";
                const url = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${apiKey}`;
                
                const body = {
                    contents: [{
                        parts: [{ text: fullPrompt }]
                    }]
                };

                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });

                if (!response.ok) throw new Error(`Gemini Error: ${response.statusText}`);
                const json = await response.json();
                // Response structure: candidates[0].content.parts[0].text
                return json.candidates?.[0]?.content?.parts?.[0]?.text || "";
            }
        } catch (e) {
            console.error("AI API Error:", e);
            // Return original text or empty string on failure?
            // Prompt said: "erreurs si API fail."
            throw e; // Bubble up to batch handler
        }
        
        return text; // Fallback
    }
}
