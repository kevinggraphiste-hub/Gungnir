# Gungnir — Guide d'utilisation

> **Version :** 2.0 | **Par :** ScarletWolf | **Licence :** Propriétaire ScarletWolf

---

## 1. Démarrage rapide

### Lancer Gungnir

```bash
# Backend (terminal 1)
python -m uvicorn backend.core.main:app --host 127.0.0.1 --port 8000 --reload

# Frontend (terminal 2)
cd frontend && npm run dev
```

Accédez à **http://localhost:5173** dans votre navigateur.

---

## 2. Chat — L'interface principale

### Envoyer un message
- Tapez votre message dans la barre en bas et appuyez **Entrée** ou cliquez le bouton d'envoi
- **Shift + Entrée** pour un retour à la ligne

### Sélection du modèle
- Cliquez sur le sélecteur de modèle (en bas à gauche) pour choisir votre provider/modèle
- Ajoutez jusqu'à **5 favoris** en cliquant l'étoile ☆ à côté d'un modèle
- Recherchez parmi tous les modèles disponibles

### Dictée vocale (PTT)
- Cliquez le **micro** 🎤 pour dicter votre message
- Le texte reconnu est ajouté dans la zone de saisie

### Conversation temps réel
- Cliquez l'icône **radio** 📡 pour ouvrir le mode voix (ElevenLabs / Gemini Live)
- Parlez naturellement, Wolf répond en vocal

### Conversations
- Les conversations sont sauvegardées automatiquement
- Panneau latéral gauche (dans le chat) pour naviguer entre conversations
- **Ctrl + B** pour afficher/masquer le panneau de conversations
- Renommez une conversation en cliquant le crayon ✏️
- Supprimez avec la corbeille 🗑️

---

## 3. Agent — Configuration de Wolf

### Ame (Soul)
- Modifiez l'identité permanente de Wolf
- Le texte est injecté dans chaque conversation comme base de personnalité

### Personnalités
- **6 personnalités par défaut** : Standard, Professionnel, Amical, Mentor, Expert, Créatif
- Créez vos propres personnalités avec un prompt système personnalisé
- Activez une personnalité en cliquant dessus
- Réorganisez par glisser-déposer

### Skills (Compétences)
- Bibliothèque de compétences spécialisées (review de code, debugging, etc.)
- Créez des skills personnalisés avec prompt + outils
- Utilisez `/skill nom_du_skill` dans le chat
- Ajoutez en favoris pour accès rapide sous la barre de saisie

### Mode Agent
- **Demande** : Wolf demande la permission avant les actions sensibles
- **Autonome** : Wolf prend des initiatives (crée des skills, cherche sur le web, etc.)
- **Restreint** : Wolf n'agit que sur demande explicite

---

## 4. Conscience v3 — Module expérimental

### Activer la conscience
1. Allez dans la page **Conscience** via la barre latérale (icône 🧠)
2. Cliquez **Activer**
3. Choisissez le niveau :
   - **Basique** : Heartbeat + Journal + Volition
   - **Standard** : + Mémoire vectorielle + Reward
   - **Complète** : + Background Think + Challenger + Simulation

### Composants

#### Pyramide de besoins (Volition)
5 niveaux de besoins persistants qui génèrent des impulsions :
- **Survie Système** (P5) — Santé du système, backups
- **Intégrité** (P4) — Cohérence, promesses tenues
- **Progression** (P3) — Projets, avancement
- **Compréhension** (P2) — Questions ouvertes, conscience
- **Curiosité** (P1) — Exploration libre

Quand un besoin devient urgent, Wolf propose une **impulsion** :
- ✅ **Approuver** → Wolf exécute l'action
- ⏸️ **Reporter** → Repose la question plus tard
- ❌ **Refuser** → Urgence réduite de 50%

#### Pensées (Thought Buffer)
Wolf réfléchit entre les conversations :
- Connexions entre sujets récents
- Observations de patterns
- Prédictions

#### Reward System
Score automatique de chaque interaction :
- **Utilité** — Est-ce que ça a aidé ?
- **Précision** — L'information était-elle correcte ?
- **Ton** — Le ton était-il approprié ?
- **Autonomie** — Action spontanée vs demandée ?

#### Challenger
Auto-vérification périodique :
- Détecte les contradictions
- Flague les promesses non tenues
- Identifie les biais répétés
- Audit hebdomadaire complet

#### Simulation
Anticipe 2-3 scénarios probables :
- Basé sur les conversations récentes
- Prépare des réponses à l'avance
- Pas de la prédiction — de la **préparation**

### Désactiver
Cliquez **Désactiver** — Wolf redevient un assistant standard sans mémoire persistante.

---

## 5. Plugins

### SpearCode (IDE)
- Éditeur de code intégré avec explorateur de fichiers
- Exécution de code en temps réel
- Terminal intégré

### Navigateur
- Navigation web via Playwright
- Capture d'écran, clic, saisie
- Extraction de contenu

### Channels (Canaux)
Connectez Wolf à des messageries externes :
- **Telegram** — Bot API (facile)
- **Discord** — Webhooks / Gateway (moyen)
- **Slack** — App avec Events API (moyen)
- **WhatsApp** — Cloud API Meta (avancé, fenêtre 24h)
- **Email** — SMTP/IMAP (moyen)
- **Widget Web** — Embed sur votre site
- **API** — Endpoint REST direct

Chaque canal a un guide de configuration détaillé dans le catalogue.

### Webhooks (Intégrations)
- Créez des webhooks entrants/sortants
- Connectez à n8n, Zapier, Make, etc.

### Automata (Planificateur)
- Tâches planifiées (cron, intervalle, one-shot)
- Wolf exécute des prompts automatiquement

### Voix
- Configuration ElevenLabs & Gemini Live
- Modes : conversation, dictée, lecture

### Guide Modèles
- Comparaison des modèles LLM disponibles
- Recommandations par cas d'usage

### Analytics
- Statistiques d'utilisation
- Tokens consommés, coûts estimés

---

## 6. Paramètres

### Providers IA
- Configurez vos clés API (OpenRouter, Anthropic, OpenAI, Google, MiniMax, Ollama)
- Activez/désactivez chaque provider
- Testez la connexion

### Thèmes
- **4 thèmes prédéfinis** : Scarlet Wolf, Midnight, Forest, Ocean
- **Thème personnalisé** : Choisissez chaque couleur (fond, accent, texte, bordures)
  - Palette de 24 couleurs prédéfinies
  - Saisie hex (#FFFFFF) ou sélecteur RGB

### Langue
- Français par défaut
- Configurable dans les paramètres

### Doctor
- Diagnostic système complet
- Vérifie : providers, base de données, plugins, fichiers de données
- Lance depuis l'onglet Doctor dans les paramètres

---

## 7. Raccourcis clavier

| Raccourci | Action |
|-----------|--------|
| `Entrée` | Envoyer le message |
| `Shift + Entrée` | Nouvelle ligne |
| `Ctrl + B` | Toggle panneau conversations |
| `Ctrl + Shift + B` | Toggle barre latérale |

---

## 8. Architecture technique

```
Gungnir/
├── backend/
│   ├── core/           # FastAPI, API, providers, agents, WOLF tools
│   └── plugins/        # Plugins backend (manifest.json + routes.py)
├── frontend/
│   ├── src/core/       # React pages, stores, services
│   └── src/plugins/    # Plugins frontend (manifest.json + index.tsx)
├── data/               # SQLite DB, configs JSON, soul.md, conscience
└── GUIDE.md            # Ce fichier
```

---

## 9. Dépannage

| Problème | Solution |
|----------|----------|
| "Aucun provider configuré" | Ajoutez une clé API dans Paramètres > Providers |
| Plugin grisé dans la sidebar | Le plugin est désactivé — activez-le dans Paramètres |
| Pas de réponse vocale | Vérifiez votre clé ElevenLabs dans Paramètres |
| Conscience ne démarre pas | Activez-la dans la page Conscience (icône 🧠) |
| Erreur 500 backend | Vérifiez les logs : `python -m uvicorn ... --log-level debug` |

---

**ScarletWolf © 2026** — Tous droits réservés.
*Gungnir : la lance d'Odin qui ne manque jamais sa cible.*
