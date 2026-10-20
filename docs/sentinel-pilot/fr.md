# Sentinel : déploiement et domaine

**Résultat :** domaine, DNS, HTTPS et API validés ; second prélèvement : 0 USD.
Site : [sentinelproof.click](https://sentinelproof.click/).
Le rapport de l'application présente la limitation ATLAS décrite ci-dessous.

## Périmètre

La fabrique avait déjà créé Sentinel et l'avait déployé sur Vercel.
Ce pilote redéploie cette version, enregistre `sentinelproof.click` dans le
compte Porkbun du propriétaire et le rattache au projet Vercel existant.
Porkbun fournit le domaine et le DNS ; Vercel héberge l'application.
Il ne s'agit pas d'une création d'application depuis zéro.

## Budget et accès

Une seule inscription d'un an est autorisée, avec un plafond de 3 USD.
Le montant facturé est de 1,54 USD : le solde passe de 10 à 8,46 USD.
Le renouvellement automatique est désactivé. Le renouvellement annoncé était
de 10,81 USD ; son prix doit être vérifié à nouveau avant toute opération.
L'inscription utilise les coordonnées existantes du compte et la confidentialité
WHOIS. Le propriétaire doit effectuer toute vérification d'adresse email requise.

Les clés de production se trouvent dans
`~/.config/domain-kit/porkbun/production/api-key` et `secret-key`, avec les
permissions `0600`. Le jeton Vercel reste sur le serveur de la fabrique et est
utilisé par SSH, sans copie locale. Aucune écriture sur GitHub.

## Exécution depuis aicom

```bash
node domain-kit/scripts/sentinel-live-pilot.mjs preflight
node domain-kit/scripts/sentinel-live-pilot.mjs deploy
node domain-kit/scripts/sentinel-live-pilot.mjs run
```

`preflight` vérifie le premier achat sans prélèvement. Après l'inscription,
le nom n'est plus disponible. `deploy` crée un seul redéploiement puis vérifie
son état. Si la compilation continue, attendre et relancer la commande.
`run` ne permet l'achat qu'après validation du site et de `/api/health`.
Une nouvelle exécution de `run` réutilise le reçu et le déploiement, sans achat
supplémentaire. Le code de sortie `2` signale une attente DNS ou HTTPS.

Après la configuration DNS, l'attente est automatique : pause de 20 secondes
entre les tentatives, pendant une fenêtre de 10 minutes. Une requête déjà lancée
se termine selon son propre délai. Les états distinguent DNS, certificat, HTTPS,
application et fournisseur. `ready` exige la réussite de tous les contrôles,
y compris l'API et la base de données. L'état est enregistré dans
`data/sentinel-live/setup-status.json`. À l'expiration du délai, il reste en
attente, avec un code de sortie `2`. Pour reprendre sans passer par l'achat :
`node domain-kit/scripts/sentinel-live-pilot.mjs verify`.
Aucun contrôle ne continue après l'arrêt du processus : une nouvelle exécution
ou un planificateur externe doit le reprendre. Les erreurs d'accès nécessitent
l'attention de l'opérateur.

## Reprise et validation

L'état chiffré est conservé dans `domain-kit/data/sentinel-live/`, exclu de Git.
Ne jamais l'effacer pour réessayer. Une réponse perdue est récupérée avec la
même clé d'opération. Après 23 heures, une opération au résultat inconnu exige
une vérification manuelle. `pilot.lock` empêche les exécutions simultanées ;
après un arrêt anormal, vérifier que le processus indiqué est terminé.

Le succès exige un domaine vérifié, un DNS correct, HTTPS fonctionnel, un
health-check API réussi et aucun changement de solde lors de la seconde
exécution. Le scénario du rapport de sécurité dans le navigateur est évalué
séparément : la disponibilité du domaine ne prouve pas celle des sources externes.

Ce pilote est limité au propriétaire, au domaine et au projet indiqués.
L'adaptateur fournisseur en mode sandbox reste inchangé.

## Limitation constatée

Le scénario Berlin sur l'adresse Vercel d'origine et le nouveau domaine a renvoyé `UNKNOWN` :
la capacité payante ATLAS `atlas.situation.brief@v1` n'était pas disponible
dans le mode gratuit actuel. Aucun paiement supplémentaire à ATLAS n'a été
effectué. Cette limitation de l'application est indépendante du domaine et du DNS.
