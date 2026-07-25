/**
 * Secure Credential Manager
 * Stores credentials in IndexedDB with encryption
 * Provides backup/restore functionality
 */

class CredentialManager {
    constructor() {
        this.dbName = 'OrangeContractCredentials';
        this.dbVersion = 1;
        this.db = null;
        this.encryptionKey = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('credentials')) {
                    db.createObjectStore('credentials', { keyPath: 'key' });
                }
            };
        });
    }

    async getEncryptionKey() {
        if (this.encryptionKey) return this.encryptionKey;

        // Try to get key from localStorage
        const keyData = localStorage.getItem('orange-enc-key');
        if (keyData) {
            this.encryptionKey = await this.importKey(keyData);
            return this.encryptionKey;
        }

        // Generate new key
        this.encryptionKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );

        // Export and store in localStorage
        const exported = await crypto.subtle.exportKey('jwk', this.encryptionKey);
        localStorage.setItem('orange-enc-key', JSON.stringify(exported));

        return this.encryptionKey;
    }

    async importKey(keyData) {
        const jwk = JSON.parse(keyData);
        return await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'AES-GCM' },
            true,
            ['encrypt', 'decrypt']
        );
    }

    async encrypt(text) {
        const key = await this.getEncryptionKey();
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            data
        );
        return {
            iv: Array.from(iv),
            data: Array.from(new Uint8Array(encrypted))
        };
    }

    async decrypt(encryptedObj) {
        const key = await this.getEncryptionKey();
        const iv = new Uint8Array(encryptedObj.iv);
        const data = new Uint8Array(encryptedObj.data);
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            data
        );
        const decoder = new TextDecoder();
        return decoder.decode(decrypted);
    }

    async set(key, value) {
        const encrypted = await this.encrypt(value);
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['credentials'], 'readwrite');
            const store = transaction.objectStore('credentials');
            const request = store.put({ key, value: encrypted });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async get(key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['credentials'], 'readonly');
            const store = transaction.objectStore('credentials');
            const request = store.get(key);
            request.onsuccess = async () => {
                if (request.result) {
                    try {
                        const decrypted = await this.decrypt(request.result.value);
                        resolve(decrypted);
                    } catch (e) {
                        console.error('Decryption failed:', e);
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getAll() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['credentials'], 'readonly');
            const store = transaction.objectStore('credentials');
            const request = store.getAll();
            request.onsuccess = async () => {
                const result = {};
                for (const item of request.result) {
                    try {
                        result[item.key] = await this.decrypt(item.value);
                    } catch (e) {
                        console.error('Decryption failed for', item.key, e);
                    }
                }
                resolve(result);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async delete(key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['credentials'], 'readwrite');
            const store = transaction.objectStore('credentials');
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async exportBackup() {
        const credentials = await this.getAll();
        const backup = {
            version: 1,
            exportedAt: new Date().toISOString(),
            credentials
        };
        return JSON.stringify(backup, null, 2);
    }

    async importBackup(backupJson) {
        const backup = JSON.parse(backupJson);
        if (!backup.credentials) {
            throw new Error('Invalid backup format');
        }

        for (const [key, value] of Object.entries(backup.credentials)) {
            await this.set(key, value);
        }

        return Object.keys(backup.credentials).length;
    }

    async migrateFromLocalStorage() {
        const keys = [
            'sb-url',
            'sb-key',
            'google-client-id',
            'gemini-api-key',
            'freeagent-token'
        ];

        let migrated = 0;
        for (const key of keys) {
            const value = localStorage.getItem(key);
            if (value) {
                await this.set(key, value);
                localStorage.removeItem(key);
                migrated++;
            }
        }

        return migrated;
    }
}

// Global instance
const credentialManager = new CredentialManager();
