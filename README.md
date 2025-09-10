# Shopify Loyalty (PoC de Pontos de Fidelidade)

## 🌟 Visão Geral

Este projeto é um **prova de conceito (PoC)** de um sistema de fidelidade totalmente integrado com o **Shopify** e **Supabase**.
A ideia é simples, mas poderosa:

* Cada compra realizada no Shopify gera **pontos de fidelidade** para o cliente.
* Esses pontos podem ser **resgatados em forma de cupons de desconto**.
* Toda a lógica roda em **uma única Edge Function** no Supabase, com forte idempotência para garantir consistência mesmo em cenários de múltiplas chamadas ou retries do Shopify.

---

## 🔑 0) Pré-Requisitos

* Conta no [Supabase](https://supabase.com) com um projeto ativo.
* Acesso ao Shopify Admin:

  * **Apps → Develop apps → Create app**

    * Scopes: `read_orders`, `write_discounts`
    * Gere e guarde:

      * **Admin API access token**
      * **API secret** (usado para verificar webhooks)
  * **Settings → Notifications → Webhooks**

    * Crie webhooks para:

      * `orders/create`
      * `orders/updated`
      * `refunds/create`
    * URL: `https://<edge-url>/app/webhooks` (deploy explicado abaixo)

---

## ⚙️ 1) Migrations (Banco de Dados)

O banco é inicializado com:

* **loyalty\_members**: registro de cada cliente do programa de pontos.
* **points\_ledger**: cada movimento de pontos (+ compra / - resgate / - reembolso).
* **rewards**: catálogo de recompensas configuradas.
* **redemptions**: histórico de resgates.
* **member\_balances (view)**: saldo consolidado de pontos por membro.

Rodar migrations:

```bash
supabase db push
# ou:
# supabase migration up
```

---

## 🔐 2) Segredos no GitHub Actions

Para deploy contínuo, configure no repositório **Settings → Secrets and variables → Actions**:

* `SUPABASE_ACCESS_TOKEN` → token da CLI (pessoal/maquina).
* `SUPABASE_DB_PASSWORD` → senha do banco do projeto.
* `SUPABASE_REF` → ref do projeto Supabase (ex: `abcd1234efgh5678`).

---

## 🔐 3) Segredos no Supabase

Além disso, precisamos de segredos para a função:

* `SHOP_DOMAIN` → domínio da loja Shopify (ex: `minhaloja.myshopify.com`).
* `SHOPIFY_API_SECRET` → **Webhook signing secret** (aquele hash hex de 64 chars que aparece no painel do Shopify).
* `SHOPIFY_ADMIN_TOKEN` → Admin API token para criar cupons.
* `POINTS_MULTIPLIER` → fator de conversão (ex: `1` = 1 ponto por R\$1, `10` = 10 pontos por R\$1).

Configurar:

```bash
supabase secrets set SHOP_DOMAIN="minhaloja.myshopify.com"
supabase secrets set SHOPIFY_API_SECRET="<hash hex>"
supabase secrets set SHOPIFY_ADMIN_TOKEN="<admin token>"
supabase secrets set POINTS_MULTIPLIER="1"
```

---

## 📦 4) Coleta de Dados do Shopify

* Compras confirmadas (`financial_status = paid` e não canceladas) são processadas.
* Para cada pedido:

  * Identificamos o **email do cliente**.
  * Criamos (se necessário) um **usuário no Supabase Auth** e um registro em `loyalty_members`.
  * Registramos pontos em `points_ledger` (valor do pedido × `POINTS_MULTIPLIER`).
* Para reembolsos (`refunds/create`):

  * O sistema localiza o pedido original já creditado.
  * Deduz pontos proporcionalmente ao valor do reembolso.

---

## 🔔 5) Webhooks no Shopify

* Configure os webhooks no Shopify Admin:
  `Settings → Notifications → Webhooks`

  * Orders Create → `https://<edge-url>/app/webhooks`
  * Orders Updated → `https://<edge-url>/app/webhooks`
  * Refunds Create → `https://<edge-url>/app/webhooks`

* O Supabase Edge Function valida cada request:

  * Confere `X-Shopify-Hmac-Sha256` com `SHOPIFY_API_SECRET`.
  * Rejeita qualquer requisição inválida.

---

## 🎟️ 6) Resgate de Cupons

* Usuário envia um request `POST /app/redeem` com `reward_id` no corpo e seu **JWT de sessão** no header.
* Processo:

  1. Valida o JWT → identifica o membro.
  2. Confere se ele tem pontos suficientes.
  3. Se for a primeira vez, cria uma **Price Rule** no Shopify para a recompensa.
  4. Gera um **Discount Code único** e retorna ao cliente.
  5. Deduz pontos do ledger e grava em `redemptions`.

---

## 🛡️ 7) Idempotência e Consistência

Nosso sistema é resistente a duplicações e retries:

* Cada operação de crédito/débito em `points_ledger` tem um **campo `reason` único** (`order:123`, `refund:456`, `redeem:XYZ`).
* Índice único (`member_id`, `reason`) garante que a mesma ação **não pode ser aplicada duas vezes**.
* Se o Shopify reenviar o webhook, o sistema detecta duplicata e ignora com segurança.

Isso garante que saldos **nunca ficam inconsistentes**.

---

## 🚀 8) Deploy

O projeto já vem com workflow GitHub Actions:

```yaml
name: Deploy Supabase
on:
  push:
    branches: [ main ]
```

Cada push em `main`:

* Faz `supabase db push`.
* Faz deploy da função única `app`.

---

## ✨ 9) Benefícios do Design

* **Simplicidade**: uma função única centraliza toda a lógica.
* **Escalabilidade**: idempotência e ledger permitem alta confiabilidade.
* **Flexibilidade**: `POINTS_MULTIPLIER` ajustável via secret.
* **Segurança**:

  * RLS em todas as tabelas (usuários só leem seus próprios dados).
  * Escrita apenas pelo `service_role` usado nas funções.

---

## 📝 Conclusão

Esse PoC mostra como é possível, com poucos componentes, montar um programa de fidelidade **seguro, escalável e integrado** entre Shopify e Supabase.

Próximos passos possíveis:

* Painel de administração para configurar recompensas.
* Dashboard do cliente para acompanhar pontos e cupons.
* Suporte a múltiplas lojas / múltiplas moedas.
