# 🐍 SNAKE DASH

Snake multijugador en tiempo real con temática **Geometry Dash**.

- **Balanceo de carga**: nginx (Docker) / Ingress-NGINX (Kubernetes) con *hash consistente* por `?room=`. Cada sala vive en una réplica y las salas se reparten entre réplicas.
- **Kubernetes**: Deployment (3 réplicas + HPA), Service, Ingress, StatefulSet de PostgreSQL con PVC.
- **PostgreSQL**: tabla `scores`; el Top 10 es global y persistente.

## Despliegue en Azure
Tu juego está disponible públicamente en:
- **Dominio Azure:** http://snake-dash-jesus.northcentralus.cloudapp.azure.com
- **IP pública:** http://20.80.23.142

## Docker Compose
```bash
docker compose up --build --scale app=3
```
Abre http://localhost:8080 — prueba con varias pestañas y la misma sala. El chip **NODO** muestra la réplica que atiende tu sala (cambia el nombre de sala para verlo cambiar).

## Kubernetes (minikube / kind / Docker Desktop)
```bash
docker build -t snake-dash:latest ./app
# minikube: minikube image load snake-dash:latest   |  kind: kind load docker-image snake-dash:latest
# minikube addons enable ingress   (o instala ingress-nginx)
kubectl apply -f k8s/
kubectl -n snake-dash get pods
```
Añade `127.0.0.1 snake.local` al archivo hosts (con `minikube tunnel`) y abre http://snake.local.
Alternativa rápida: `kubectl -n snake-dash port-forward svc/snake-app 8080:80`.

## Controles
Flechas / WASD (o deslizar en móvil). Orbes +10, monedas +30. Pinchos en los bordes, choques con otros cubos o contigo mismo = CRASH.
