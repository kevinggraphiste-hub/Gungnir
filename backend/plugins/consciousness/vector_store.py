"""
Gungnir Consciousness — Vector Store Abstraction
==================================================
Mémoire épisodique vectorielle pour la conscience.
Supporte : ChromaDB (local), Pinecone (cloud), Qdrant (cloud/self-hosted).

L'embedding est généré via l'API du provider configuré (OpenAI, Google, etc.)
ou via un modèle d'embedding dédié.
"""

import logging
import time
import hashlib
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Optional

import httpx

logger = logging.getLogger("gungnir.consciousness.vector")

# ── Embedding Generator ─────────────────────────────────────────────────────

class EmbeddingGenerator:
    """Generates embeddings via external API (OpenAI-compatible or Google)."""

    # Dimensions connues — évite que la collection Qdrant soit créée avec une
    # mauvaise taille (ex: 1536 par défaut alors que text-embedding-004 fait
    # 768 → tout upsert ensuite throw « dimension mismatch »).
    KNOWN_DIMENSIONS = {
        # Google
        "text-embedding-004": 768,
        "embedding-001": 768,
        "text-embedding-005": 768,
        # OpenAI
        "text-embedding-3-small": 1536,
        "text-embedding-3-large": 3072,
        "text-embedding-ada-002": 1536,
        # Cohere
        "embed-english-v3.0": 1024,
        "embed-multilingual-v3.0": 1024,
        # Mistral
        "mistral-embed": 1024,
        # DeepSeek (API OpenAI-compatible — pas de modèle d'embedding
        # officiel propre à DeepSeek à ce jour, on tente leur endpoint
        # générique. Si 404, l'user a un message clair.)
        "deepseek-embed": 1536,
    }

    def __init__(self, config: dict):
        self.provider = config.get("embedding_provider", "openai")
        self.model = config.get("embedding_model", "text-embedding-3-small")
        self.api_key = config.get("embedding_api_key", "")
        self.base_url = config.get("embedding_base_url", "")
        # Dim : on prend la valeur connue pour ce modèle si possible, sinon
        # la config user, sinon 1536 par défaut. Sera affinée par
        # `detect_dimension()` au moment de l'init.
        configured = config.get("embedding_dimension")
        known = self.KNOWN_DIMENSIONS.get(self.model)
        self._dimension = known or configured or 1536

    @property
    def dimension(self) -> int:
        return self._dimension

    async def detect_dimension(self) -> int:
        """Embed un texte test et retourne la VRAIE dimension. Met à jour
        self._dimension. À appeler après init si la valeur configurée est
        suspecte (ex: collection existante avec dim != réelle)."""
        try:
            sample = await self.embed_single("ping")
            self._dimension = len(sample)
        except Exception:
            pass
        return self._dimension

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for a batch of texts."""
        if not self.api_key:
            raise ValueError("Clé API embedding non configurée")

        if self.provider == "google":
            return await self._embed_google(texts)
        if self.provider == "mistral":
            return await self._embed_mistral(texts)
        if self.provider == "deepseek":
            return await self._embed_deepseek(texts)
        return await self._embed_openai(texts)

    async def _embed_openai(self, texts: list[str]) -> list[list[float]]:
        """OpenAI / OpenRouter compatible embedding API."""
        url = self.base_url or "https://api.openai.com/v1/embeddings"
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, json={
                "model": self.model,
                "input": texts,
            }, headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            })
            resp.raise_for_status()
            data = resp.json()
            return [item["embedding"] for item in data["data"]]

    async def _embed_google(self, texts: list[str]) -> list[list[float]]:
        """Google Generative AI embedding API.

        Essaie le modèle configuré, puis fallback sur des alternatives connues
        (Google a migré/renommé certains modèles selon régions et plans). Le
        premier modèle qui répond sans 404 gagne. La dim est capturée à partir
        du résultat — pas besoin de la connaître à l'avance.
        """
        # Ordre de fallback : modèle configuré d'abord, puis alternatives.
        candidates = [self.model]
        for alt in ("text-embedding-004", "gemini-embedding-001", "embedding-001", "text-embedding-005"):
            if alt not in candidates:
                candidates.append(alt)

        last_error: str | None = None
        async with httpx.AsyncClient(timeout=30.0) as client:
            for model_name in candidates:
                requests_body = [
                    {"model": f"models/{model_name}", "content": {"parts": [{"text": t}]}}
                    for t in texts
                ]
                # v1beta supporte batchEmbedContents pour tous les modèles
                # embedding actuels — on n'essaie plus v1 (souvent 404 sur ces
                # modèles, polluait les logs).
                url = (
                    f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}"
                    f":batchEmbedContents?key={self.api_key}"
                )
                try:
                    resp = await client.post(url, json={"requests": requests_body})
                except Exception as e:
                    last_error = f"connect error sur {model_name}: {e}"
                    continue
                if resp.status_code == 404:
                    last_error = f"404 sur {model_name}"
                    continue
                if resp.status_code >= 400:
                    last_error = f"{resp.status_code} sur {model_name}: {resp.text[:200]}"
                    if resp.status_code in (401, 403):
                        # Clé invalide / permissions — inutile d'essayer d'autres modèles
                        break
                    continue
                data = resp.json()
                emb = [item["values"] for item in data["embeddings"]]
                # Si on a fallback sur un autre modèle, sync self.model pour
                # cohérence + log.
                if model_name != self.model:
                    logger.info(
                        f"Google embedding fallback: {self.model} → {model_name} "
                        f"(dim={len(emb[0]) if emb else '?'})"
                    )
                    self.model = model_name
                return emb
        raise ValueError(
            f"Aucun modèle embedding Google ne répond. Dernière erreur : "
            f"{last_error or 'inconnue'}. Modèles essayés : {', '.join(candidates)}."
        )

    async def _embed_mistral(self, texts: list[str]) -> list[list[float]]:
        """Mistral API embedding — endpoint OpenAI-compatible.

        Modèle officiel : `mistral-embed` (1024 dimensions).
        URL par défaut : https://api.mistral.ai/v1/embeddings (override via
        embedding_base_url si l'user pointe sur une instance custom).
        """
        url = self.base_url or "https://api.mistral.ai/v1/embeddings"
        model = self.model or "mistral-embed"
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, json={
                "model": model,
                "input": texts,
            }, headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            })
            if resp.status_code >= 400:
                raise ValueError(
                    f"Mistral embedding {resp.status_code} : "
                    f"{resp.text[:300]} (modèle: '{model}')"
                )
            data = resp.json()
            return [item["embedding"] for item in data["data"]]

    async def _embed_deepseek(self, texts: list[str]) -> list[list[float]]:
        """DeepSeek API embedding — endpoint OpenAI-compatible.

        Note : DeepSeek se concentre sur les LLM (chat, code, reasoning)
        et n'expose pas de modèle d'embedding officiel à ce jour. Leur
        API est OpenAI-compatible donc on tente `/v1/embeddings` avec
        le modèle configuré par l'user. Si 404, message d'erreur clair.

        URL par défaut : https://api.deepseek.com/v1/embeddings
        """
        url = self.base_url or "https://api.deepseek.com/v1/embeddings"
        model = self.model or "deepseek-embed"
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, json={
                "model": model,
                "input": texts,
            }, headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            })
            if resp.status_code == 404:
                raise ValueError(
                    f"DeepSeek n'expose pas de modèle d'embedding officiel "
                    f"(404 sur '{model}'). Recommandation : utilise OpenAI, "
                    f"Google ou Mistral pour l'embedding. Tu peux quand même "
                    f"garder DeepSeek pour le chat (LLM) à part."
                )
            if resp.status_code >= 400:
                raise ValueError(
                    f"DeepSeek embedding {resp.status_code} : "
                    f"{resp.text[:300]} (modèle: '{model}')"
                )
            data = resp.json()
            return [item["embedding"] for item in data["data"]]

    async def embed_single(self, text: str) -> list[float]:
        """Embed a single text."""
        results = await self.embed([text])
        return results[0]


# ── Vector Store Base ────────────────────────────────────────────────────────

class VectorStoreBase(ABC):
    """Abstract vector store interface."""

    @abstractmethod
    async def connect(self) -> bool:
        """Test connection. Returns True if successful."""
        ...

    @abstractmethod
    async def ensure_collection(self, name: str, dimension: int) -> None:
        """Create collection if it doesn't exist."""
        ...

    @abstractmethod
    async def upsert(self, collection: str, doc_id: str, embedding: list[float],
                     metadata: dict, text: str) -> None:
        """Insert or update a vector."""
        ...

    @abstractmethod
    async def search(self, collection: str, query_embedding: list[float],
                     top_k: int = 5, filter_meta: dict | None = None) -> list[dict]:
        """Semantic search. Returns list of {id, text, metadata, score}."""
        ...

    @abstractmethod
    async def delete(self, collection: str, doc_id: str) -> None:
        """Delete a vector by ID."""
        ...

    @abstractmethod
    async def count(self, collection: str) -> int:
        """Count vectors in collection."""
        ...

    @abstractmethod
    async def info(self) -> dict:
        """Connection info for status display."""
        ...


# ── ChromaDB (local, zero-config) ───────────────────────────────────────────

class ChromaVectorStore(VectorStoreBase):
    """Local ChromaDB — parfait pour le développement. Pas de serveur externe requis."""

    def __init__(self, config: dict):
        self.persist_dir = config.get("chroma_persist_dir", "data/consciousness/chroma_db")
        self._client = None

    def _get_client(self):
        if self._client is None:
            try:
                import chromadb
                self._client = chromadb.PersistentClient(path=self.persist_dir)
            except ImportError:
                raise ImportError("chromadb non installé. Lancez: pip install chromadb")
        return self._client

    async def connect(self) -> bool:
        try:
            client = self._get_client()
            client.heartbeat()
            return True
        except Exception as e:
            logger.error(f"ChromaDB connection failed: {e}")
            return False

    async def ensure_collection(self, name: str, dimension: int) -> None:
        client = self._get_client()
        client.get_or_create_collection(name=name, metadata={"dimension": dimension})

    async def upsert(self, collection: str, doc_id: str, embedding: list[float],
                     metadata: dict, text: str) -> None:
        client = self._get_client()
        col = client.get_or_create_collection(name=collection)
        col.upsert(ids=[doc_id], embeddings=[embedding], metadatas=[metadata], documents=[text])

    async def search(self, collection: str, query_embedding: list[float],
                     top_k: int = 5, filter_meta: dict | None = None) -> list[dict]:
        client = self._get_client()
        col = client.get_or_create_collection(name=collection)
        kwargs: dict = {"query_embeddings": [query_embedding], "n_results": top_k}
        if filter_meta:
            kwargs["where"] = filter_meta
        results = col.query(**kwargs)
        items = []
        for i in range(len(results["ids"][0])):
            items.append({
                "id": results["ids"][0][i],
                "text": results["documents"][0][i] if results["documents"] else "",
                "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                "score": 1.0 - (results["distances"][0][i] if results["distances"] else 0),
            })
        return items

    async def delete(self, collection: str, doc_id: str) -> None:
        client = self._get_client()
        col = client.get_or_create_collection(name=collection)
        col.delete(ids=[doc_id])

    async def count(self, collection: str) -> int:
        client = self._get_client()
        col = client.get_or_create_collection(name=collection)
        return col.count()

    async def info(self) -> dict:
        try:
            client = self._get_client()
            return {
                "provider": "chromadb",
                "status": "connected",
                "persist_dir": self.persist_dir,
                "collections": [c.name for c in client.list_collections()],
            }
        except Exception as e:
            return {"provider": "chromadb", "status": "error", "error": str(e)}


# ── Pinecone (cloud) ────────────────────────────────────────────────────────

class PineconeVectorStore(VectorStoreBase):
    """Pinecone cloud — production-grade, managed vector DB."""

    def __init__(self, config: dict):
        self.api_key = config.get("pinecone_api_key", "")
        self.environment = config.get("pinecone_environment", "")
        self.index_name = config.get("pinecone_index", "gungnir-consciousness")
        self._index = None

    def _get_index(self):
        if self._index is None:
            try:
                from pinecone import Pinecone
                pc = Pinecone(api_key=self.api_key)
                self._index = pc.Index(self.index_name)
            except ImportError:
                raise ImportError("pinecone non installé. Lancez: pip install pinecone")
        return self._index

    async def connect(self) -> bool:
        try:
            idx = self._get_index()
            idx.describe_index_stats()
            return True
        except Exception as e:
            logger.error(f"Pinecone connection failed: {e}")
            return False

    async def ensure_collection(self, name: str, dimension: int) -> None:
        # Pinecone uses namespaces within an index, no explicit creation needed
        pass

    async def upsert(self, collection: str, doc_id: str, embedding: list[float],
                     metadata: dict, text: str) -> None:
        idx = self._get_index()
        meta = {**metadata, "_text": text[:40000]}  # Pinecone metadata limit
        idx.upsert(vectors=[{"id": doc_id, "values": embedding, "metadata": meta}],
                   namespace=collection)

    async def search(self, collection: str, query_embedding: list[float],
                     top_k: int = 5, filter_meta: dict | None = None) -> list[dict]:
        idx = self._get_index()
        kwargs: dict = {
            "vector": query_embedding,
            "top_k": top_k,
            "include_metadata": True,
            "namespace": collection,
        }
        if filter_meta:
            kwargs["filter"] = filter_meta
        results = idx.query(**kwargs)
        return [{
            "id": m.id,
            "text": m.metadata.pop("_text", "") if m.metadata else "",
            "metadata": m.metadata or {},
            "score": m.score,
        } for m in results.matches]

    async def delete(self, collection: str, doc_id: str) -> None:
        idx = self._get_index()
        idx.delete(ids=[doc_id], namespace=collection)

    async def count(self, collection: str) -> int:
        idx = self._get_index()
        stats = idx.describe_index_stats()
        ns = stats.namespaces.get(collection, None)
        return ns.vector_count if ns else 0

    async def info(self) -> dict:
        try:
            idx = self._get_index()
            stats = idx.describe_index_stats()
            return {
                "provider": "pinecone",
                "status": "connected",
                "index": self.index_name,
                "total_vectors": stats.total_vector_count,
                "namespaces": list(stats.namespaces.keys()),
            }
        except Exception as e:
            return {"provider": "pinecone", "status": "error", "error": str(e)}


# ── Qdrant (self-hosted / cloud) ────────────────────────────────────────────

class QdrantVectorStore(VectorStoreBase):
    """Qdrant — performant, auto-hébergeable ou cloud."""

    def __init__(self, config: dict):
        self.url = config.get("qdrant_url", "http://localhost:6333")
        self.api_key = config.get("qdrant_api_key", "")

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["api-key"] = self.api_key
        return h

    async def connect(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{self.url}/healthz", headers=self._headers())
                return resp.status_code == 200
        except Exception as e:
            logger.error(f"Qdrant connection failed: {e}")
            return False

    async def ensure_collection(self, name: str, dimension: int) -> None:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Check if exists
            resp = await client.get(f"{self.url}/collections/{name}", headers=self._headers())
            if resp.status_code == 200:
                return
            # Create
            await client.put(f"{self.url}/collections/{name}", headers=self._headers(), json={
                "vectors": {"size": dimension, "distance": "Cosine"}
            })

    async def upsert(self, collection: str, doc_id: str, embedding: list[float],
                     metadata: dict, text: str) -> None:
        # Qdrant uses integer IDs or UUIDs — hash the string ID
        point_id = hashlib.md5(doc_id.encode()).hexdigest()
        payload = {**metadata, "_text": text, "_original_id": doc_id}
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.put(f"{self.url}/collections/{collection}/points", headers=self._headers(), json={
                "points": [{"id": point_id, "vector": embedding, "payload": payload}]
            })

    async def search(self, collection: str, query_embedding: list[float],
                     top_k: int = 5, filter_meta: dict | None = None) -> list[dict]:
        body: dict = {"vector": query_embedding, "limit": top_k, "with_payload": True}
        if filter_meta:
            body["filter"] = {"must": [{"key": k, "match": {"value": v}} for k, v in filter_meta.items()]}
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{self.url}/collections/{collection}/points/search",
                                     headers=self._headers(), json=body)
            resp.raise_for_status()
            data = resp.json()
        return [{
            "id": hit["payload"].get("_original_id", str(hit["id"])),
            "text": hit["payload"].pop("_text", ""),
            "metadata": {k: v for k, v in hit["payload"].items() if not k.startswith("_")},
            "score": hit["score"],
        } for hit in data.get("result", [])]

    async def delete(self, collection: str, doc_id: str) -> None:
        point_id = hashlib.md5(doc_id.encode()).hexdigest()
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(f"{self.url}/collections/{collection}/points/delete",
                              headers=self._headers(), json={"points": [point_id]})

    async def count(self, collection: str) -> int:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self.url}/collections/{collection}", headers=self._headers())
            if resp.status_code != 200:
                return 0
            return resp.json().get("result", {}).get("points_count", 0)

    async def info(self) -> dict:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{self.url}/collections", headers=self._headers())
                resp.raise_for_status()
                collections = [c["name"] for c in resp.json().get("result", {}).get("collections", [])]
            return {
                "provider": "qdrant",
                "status": "connected",
                "url": self.url,
                "collections": collections,
            }
        except Exception as e:
            return {"provider": "qdrant", "status": "error", "error": str(e)}


# ── Factory ──────────────────────────────────────────────────────────────────

PROVIDERS = {
    "chromadb": ChromaVectorStore,
    "pinecone": PineconeVectorStore,
    "qdrant": QdrantVectorStore,
}

def create_vector_store(config: dict) -> VectorStoreBase | None:
    """Create a vector store from config. Returns None if disabled."""
    provider = config.get("vector_provider", "")
    if not provider or provider == "none":
        return None
    cls = PROVIDERS.get(provider)
    if not cls:
        logger.warning(f"Unknown vector provider: {provider}")
        return None
    return cls(config)


# ── Consciousness Memory Manager ────────────────────────────────────────────

COLLECTION_THOUGHTS = "consciousness_thoughts"
COLLECTION_MEMORIES = "consciousness_memories"
COLLECTION_INTERACTIONS = "consciousness_interactions"


def _user_collection(base: str, user_id: int | None) -> str:
    """Namespace collection by user_id to isolate per-user data."""
    if user_id and user_id != 0:
        return f"{base}_u{user_id}"
    return base


class ConsciousnessVectorMemory:
    """
    High-level vector memory for consciousness.
    Wraps vector store + embedding generator into semantic operations.
    Each user gets their own Qdrant collections (namespaced by user_id).
    """

    def __init__(self, config: dict):
        self._config = config
        self._store: VectorStoreBase | None = None
        self._embedder: EmbeddingGenerator | None = None
        self._ready = False
        self._user_id = config.get("_user_id", 0)
        # Trace de la dernière erreur d'écriture (embed/upsert) — exposée par
        # les tools agent (consciousness_remember) pour diagnostic en live.
        self._last_error: str | None = None

    @property
    def enabled(self) -> bool:
        return self._config.get("vector_provider", "none") != "none"

    @property
    def ready(self) -> bool:
        return self._ready

    async def initialize(self) -> bool:
        """Initialize store + embedder. Returns True if ready."""
        if not self.enabled:
            return False

        try:
            self._store = create_vector_store(self._config)
            if not self._store:
                return False

            self._embedder = EmbeddingGenerator(self._config)

            connected = await self._store.connect()
            if not connected:
                logger.warning("Vector store connection failed")
                return False

            # Détecte la VRAIE dim via un embed test — corrige le cas où la
            # config user/global avait une dim incorrecte (ex: 1536 par défaut
            # alors que text-embedding-004 fait 768). Sans ça, les collections
            # étaient créées avec une mauvaise taille → tout upsert ensuite
            # plantait silencieusement.
            real_dim = await self._embedder.detect_dimension()
            for base_col in [COLLECTION_THOUGHTS, COLLECTION_MEMORIES, COLLECTION_INTERACTIONS]:
                col = _user_collection(base_col, self._user_id)
                await self._ensure_collection_with_correct_dim(col, real_dim)

            self._ready = True
            logger.info(f"Vector memory initialized: {self._config.get('vector_provider')}")
            return True

        except Exception as e:
            logger.error(f"Vector memory init failed: {e}")
            self._ready = False
            return False

    async def _ensure_collection_with_correct_dim(self, col: str, expected_dim: int) -> None:
        """Crée la collection si absente, ou la drop+recrée si la dim diffère.

        Spécifique Qdrant : on inspecte `info` pour récupérer la dim courante.
        Pour les autres providers (Chroma/Pinecone), on délègue à `ensure_collection`
        qui fera son propre check.
        """
        store = self._store
        if store is None:
            return
        # Cas simple : on essaie ensure_collection (créera si absente)
        await store.ensure_collection(col, expected_dim)

        # Vérification spécifique Qdrant : si la collection existait avec une
        # mauvaise dim, on la drop+recrée. On ne perd que des vecteurs déjà
        # invalides (jamais utilisables avec la nouvelle dim).
        try:
            from .vector_store import QdrantVectorStore  # noqa
            if not isinstance(store, QdrantVectorStore):
                return
        except Exception:
            return
        try:
            import httpx
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{store.url}/collections/{col}", headers=store._headers())
                if resp.status_code != 200:
                    return
                data = resp.json().get("result", {})
                vectors = data.get("config", {}).get("params", {}).get("vectors", {})
                current_dim = vectors.get("size") if isinstance(vectors, dict) else None
                if current_dim and int(current_dim) != int(expected_dim):
                    logger.warning(
                        f"Collection {col} dim mismatch (got {current_dim}, "
                        f"expected {expected_dim}) — recreating"
                    )
                    await client.delete(f"{store.url}/collections/{col}", headers=store._headers())
                    await store.ensure_collection(col, expected_dim)
        except Exception as e:
            logger.debug(f"Could not verify Qdrant collection dim for {col}: {e}")

    async def store_thought(self, thought_id: str, content: str,
                            thought_type: str, confidence: float,
                            source_files: list[str] | None = None) -> bool:
        """Store a thought with semantic embedding."""
        if not self._ready:
            self._last_error = "vector memory not ready"
            return False
        try:
            embedding = await self._embedder.embed_single(content)
            await self._store.upsert(
                collection=_user_collection(COLLECTION_THOUGHTS, self._user_id),
                doc_id=thought_id,
                embedding=embedding,
                metadata={
                    "type": thought_type,
                    "confidence": confidence,
                    "source_files": ",".join(source_files or []),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
                text=content,
            )
            self._last_error = None
            return True
        except Exception as e:
            self._last_error = f"{type(e).__name__}: {str(e)[:300]}"
            logger.error(f"Failed to store thought vector: {e}")
            return False

    async def store_memory(self, memory_id: str, content: str,
                           category: str, key: str = "") -> bool:
        """Store a working memory item with semantic embedding."""
        if not self._ready:
            self._last_error = "vector memory not ready (init failed or provider=none)"
            return False
        try:
            embedding = await self._embedder.embed_single(content)
            await self._store.upsert(
                collection=_user_collection(COLLECTION_MEMORIES, self._user_id),
                doc_id=memory_id,
                embedding=embedding,
                metadata={
                    "category": category,
                    "key": key,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
                text=content,
            )
            self._last_error = None
            return True
        except Exception as e:
            self._last_error = f"{type(e).__name__}: {str(e)[:300]}"
            logger.error(f"Failed to store memory vector: {e}")
            return False

    async def store_interaction(self, interaction_id: str, content: str,
                                interaction_type: str, score: float = 0.0) -> bool:
        """Store an interaction summary for long-term recall."""
        if not self._ready:
            return False
        try:
            embedding = await self._embedder.embed_single(content)
            await self._store.upsert(
                collection=_user_collection(COLLECTION_INTERACTIONS, self._user_id),
                doc_id=interaction_id,
                embedding=embedding,
                metadata={
                    "type": interaction_type,
                    "score": score,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
                text=content,
            )
            return True
        except Exception as e:
            logger.error(f"Failed to store interaction vector: {e}")
            return False

    async def recall(self, query: str, collection: str | None = None,
                     top_k: int = 5, filter_meta: dict | None = None) -> list[dict]:
        """Semantic search across consciousness memories.

        `collection` accepte un nom court (`memories`, `thoughts`, `interactions`)
        OU le nom complet (`consciousness_memories`). On normalise en interne
        pour rester cohérent avec store_memory/store_thought/store_interaction
        qui écrivent dans `consciousness_*` (sans quoi le recall cherchait dans
        `memories_u1` alors que les writes étaient dans `consciousness_memories_u1`).
        """
        if not self._ready:
            return []
        # Mapping nom court → constante (préfixée `consciousness_*`)
        SHORT_TO_FULL = {
            "thoughts": COLLECTION_THOUGHTS,
            "memories": COLLECTION_MEMORIES,
            "interactions": COLLECTION_INTERACTIONS,
        }
        try:
            embedding = await self._embedder.embed_single(query)
            if collection:
                full_name = SHORT_TO_FULL.get(collection, collection)
                collections = [_user_collection(full_name, self._user_id)]
            else:
                collections = [
                    _user_collection(COLLECTION_THOUGHTS, self._user_id),
                    _user_collection(COLLECTION_MEMORIES, self._user_id),
                    _user_collection(COLLECTION_INTERACTIONS, self._user_id),
                ]
            all_results = []
            for col in collections:
                results = await self._store.search(col, embedding, top_k, filter_meta)
                for r in results:
                    r["collection"] = col
                all_results.extend(results)

            # Sort by score descending, take top_k
            all_results.sort(key=lambda x: x.get("score", 0), reverse=True)
            return all_results[:top_k]
        except Exception as e:
            logger.error(f"Vector recall failed: {e}")
            return []

    async def get_status(self) -> dict:
        """Status info for the dashboard."""
        if not self.enabled:
            return {"enabled": False, "provider": "none"}
        if not self._ready:
            return {"enabled": True, "provider": self._config.get("vector_provider", ""), "status": "disconnected"}

        try:
            store_info = await self._store.info()
            counts = {}
            for base_col in [COLLECTION_THOUGHTS, COLLECTION_MEMORIES, COLLECTION_INTERACTIONS]:
                col = _user_collection(base_col, self._user_id)
                counts[base_col] = await self._store.count(col)
            return {
                "enabled": True,
                "ready": True,
                "provider": self._config.get("vector_provider", ""),
                "embedding_model": self._config.get("embedding_model", ""),
                "store_info": store_info,
                "collections": counts,
                "total_vectors": sum(counts.values()),
            }
        except Exception as e:
            return {"enabled": True, "ready": True, "provider": self._config.get("vector_provider", ""), "error": str(e)}

    async def test_connection(self) -> dict:
        """Test full pipeline: embedding + store."""
        result = {"embedding": False, "store": False, "search": False}

        # Test embedding
        try:
            self._embedder = EmbeddingGenerator(self._config)
            vec = await self._embedder.embed_single("Test de connexion Gungnir")
            result["embedding"] = True
            result["dimension"] = len(vec)
        except Exception as e:
            result["embedding_error"] = str(e)
            return result

        # Test store connection
        try:
            store = create_vector_store(self._config)
            if store and await store.connect():
                result["store"] = True
            else:
                result["store_error"] = "Connection failed"
                return result
        except Exception as e:
            result["store_error"] = str(e)
            return result

        # Test search (write + read)
        try:
            test_col = "gungnir_test"
            await store.ensure_collection(test_col, len(vec))
            await store.upsert(test_col, "test_ping", vec, {"test": True}, "ping")
            hits = await store.search(test_col, vec, top_k=1)
            result["search"] = len(hits) > 0
            await store.delete(test_col, "test_ping")
        except Exception as e:
            result["search_error"] = str(e)

        return result
