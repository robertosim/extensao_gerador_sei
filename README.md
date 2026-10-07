# Gerador SEI — Extensão do Chrome (MV3)

Extensão que automatiza o fluxo **dentro do navegador**: gera processos no SEI a
partir de um CSV, baixa os espelhos no PGT e anexa os PDFs — sem servidor local
e sem dependências externas.

## Instalação

1. Abra `chrome://extensions`
2. Ative **Modo do desenvolvedor**
3. **Carregar descompactada** e escolha a pasta do projeto
4. Tenha uma aba logada em https://sei.incra.gov.br (e, para os downloads,
   https://pgt.incra.gov.br)

> Chrome mark-branded não aceita `--load-extension`; para testes automatizados,
> carregue a pasta num Chromium/Chromium puro.

## Abas do painel

| Aba | O que faz |
|-----|-----------|
| **Gerar** | Carrega o CSV, escolhe Tipo do Processo / especificação / interessados / hipótese legal e cria os processos no SEI. Barra de progresso `gerando X de Y`, botões **Pausar**/**Continuar** e **Cancelar** (mantém a fila), **Repetir falhas**, **Limpar** e **Exportar** (`relatorio_gerador_sei.csv`) |
| **Baixar** | Baixa o **Espelho da Unidade Familiar** de cada beneficiário da fila no PGT. Barra `baixando X de Y`, **Pausar**/**Continuar**, **Cancelar** (para e **zera o progresso**, os registros ficam na fila) e **Executar novamente (erros)**. Arquivos caem em `Downloads/arquivos_pgt/` |
| **Anexar** | Sobe os PDFs, configura tipo do documento / nome da árvore / nível / hipótese e anexa no SEI. Barra `anexando X de Y`, **Pausar**/**Continuar**, **Cancelar** e **Repetir falhas**. Os registros (código, nome, processo SEI **e as colunas do CSV**) vêm do CSV da aba Gerar; o quadro **Pendências** mostra o que falta por registro (sem PDF, sem processo, coringa sem dado) e a tabela traz a coluna **Data Anexo** |
| **Log** | Log unificado das três execuções (`Gerar`, `Baixar`, `Anexar`) com limpeza manual |

Rodapé: **Manter SEI vivo** e **Manter PGT vivo** recarregam cada aba
periodicamente (dois alarmes independentes no `background.js`, então seguem com
o painel fechado); **Recarregar agora** força a recarga na hora e o aviso de
sessão expirada aparece ao lado do controle.

## Coringas `{{...}}`

Os templates de **Nome na árvore** (aba Anexar) e de **Especificação** /
**Interessados** / **Observações** (aba Gerar) aceitam coringas resolvidos a
partir de **três fontes**, nesta ordem:

1. **Colunas da própria tabela** — `cod_sipra`, `nome`, `processo_sei`,
   `pdf_anexo`, `data_anexo`...
2. **Colunas do CSV** — guardadas em `dados_csv` (JSON da linha), alimentadas
   pelo CSV carregado na aba Gerar
3. **Apelidos amigáveis** — `{{Codigo SIPRA}}`, `{{Nome Titular 1}}`,
   `{{NUP}}`, `{{Serie}}`, `{{Hipotese legal}}`...

Fonte com valor vazio não bloqueia a próxima (uma coluna vazia no CSV deixa o
apelido cair no campo da tabela), a busca casa por fragmento
(`{{Nome Titular}}` acha `NOME TITULAR 1`) e **coringa sem dado fica visível**
no nome da árvore (ex.: `{{Lote}}`) — assim o problema aparece na cara e o
quadro de Pendências aponta o registro.

## Arquivos

| Arquivo | Papel |
|---------|-------|
| `manifest.json` | MV3: permissões, content scripts, ícones |
| `background.js` | Service worker: keep-alive, tick da aba, badge, `chrome.downloads` |
| `content.js` | Máquina de estados dos passos ANEXAR/GERAR no SEI (claim, RPC) |
| `pgt.js` | Máquina de estados dos passos de download no PGT |
| `main_world.js` | Ponte RPC no mundo da página (funções do SEI) |
| `popup.html/css/js` | Painel de controle (abas, progresso, exportar) |
| `comum.js` | `chrome.storage.local`, CSV, coringas (3 fontes), pendências, log |
| `listas.js` | Listas do SEI (tipos de processo/documento, hipóteses) |
| `icons/` | Ícones da extensão (16, 32, 48 e 128 px) |

## Como funciona

- Todo o estado fica em `chrome.storage.local`: `fila` (registros do CSV),
  `execucao` (máquina de estados: tipo, passo, pausado, contadores), `log`,
  `cfg_geracao`, `cfg_anexo`, `keepalive` (SEI) e `keepalive_pgt` (PGT)
- Um tique a cada 600 ms (mais o alarme do `background.js`) avança um passo;
  timeout de 90 s por passo — 300 s para o passo de download
- A cada passo um *claim* de 6 s evita que frames concorrentes executem o mesmo
  passo; passos com falha marcam o item e não são repetidos no mesmo ciclo
- `content.js` cuida de `gerar`/`anexar` na aba do SEI; `pgt.js` cuida de
  `download` na aba do PGT (abrir busca → digitar código → Pesquisar →
  detalhar → **Baixar relatorio**); o arquivo é salvo pelo `chrome.downloads` do
  `background.js`, que avisa o `pgt.js` ao terminar
- Apenas uma execução por vez: começar outra mostra o aviso de fila ocupada
- Com o navegador minimizado, outra aba ativa ou em outra área de trabalho o
  Chrome reduz os timers, **congela** a aba (Energy Saver) ou a **descarta**
  (Memory Saver). A execução continua mesmo assim: o `background.js` dispara o
  tique a cada 30 s, o motor mantém um *Web Lock* ativo (isenção oficial de
  freeze), as abas do SEI/PGT ficam `autoDiscardable=false` enquanto a execução
  roda e uma aba que para de responder é recarregada (o estado sai do
  `chrome.storage.local`); os eventos de freeze/resume entram no **Log**
- Os botões do painel são ligados por um helper que só registra o evento quando
  o elemento existe (e avisa no console) — um botão que suma do HTML não derruba
  os demais

## Padrões

- **Tipo do processo**: `100000508` — *Finalístico: Desenvolvimento de
  Assentamentos* (pré-selecionado; troque na aba Gerar)
- **Listas suspensas**: tipo do processo, tipo do documento e **hipótese legal**
  mostram **só o texto** (sem o número na frente); o código continua no `value`
  da opção e é ele que o SEI recebe
- **Colunas do CSV**: código do beneficiário, nome do titular 1 e nº do processo
  SEI (aceita `;` ou `,`, UTF-8/CP1252/Latin-1)
- **Espelhos**: `Downloads/arquivos_pgt/<nome original do arquivo>` (o nome vem do
  próprio PGT; em colisão o `background.js` acrescenta o código do beneficiário)

## Solução de problemas

| Problema | Solução |
|----------|---------|
| Sessão expirada | Refaça o login no SEI/PGT na aba correspondente e reinicie a execução |
| Download falha | Confira se a aba do PGT está aberta e logada; use **Executar novamente (erros)** |
| Nada acontece ao clicar no ícone | Recarregue a extensão em `chrome://extensions` |
| Fila ocupada | Termine ou cancele a execução atual antes de iniciar outra |
| Automação parada com o navegador minimizado | Veja o **Log**: se aparecer `Aba ... congelada pelo Chrome` a aba foi congelada/recarregada; mantenha a aba do SEI logada e a extensão carregada |
| Aba do SEI/PGT volta sozinha | É o keep-alive do rodapé (alarme a cada N s); desmarque **Manter ... vivo** ou aumente o intervalo |

## Suporte

**Desenvolvido por Roberto Simões**

| Canal | Contato |
|-------|---------|
| E-mail | [robsimoes@gmail.com](mailto:robsimoes@gmail.com) |
| WhatsApp | +55 (48) 99679-3828 |
| LinkedIn | [linkedin.com/in/robertosim](https://www.linkedin.com/in/robertosim) |
