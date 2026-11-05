# provedores: o seu 9router dentro do Claude Code

Um mod para o Claude Code que usa os **combos do seu [9router](https://github.com/decolua/9router)** do mesmo jeito que você usa o Claude, sem trocar o seu login:

- **Chave Claude | 9router** acima da caixa de mensagem: liga e desliga quando quiser. Toda sessão começa em Claude.
- **Seletor de combo** ao lado da chave, ou `/provedor <nome>` (por exemplo `/provedor sol`). `/provedor claude` volta para o Claude.
- **Combos como subagentes:** cada combo do seu 9router vira um subagente `provedores:<combo>`. Peça "usa os subagentes 9router" e o Claude chama os combos.
- **Todas as ferramentas:** os combos usam `Read`, `Edit`, `Bash` e as outras ferramentas comuns, e carregam qualquer conector pela `ToolSearch`.
- **Streaming:** o texto aparece enquanto é escrito, e o Esc interrompe.
- **Economia de tokens:** a lista de ferramentas vai resumida, os resultados antigos grandes são encurtados nos combos sem cache, e os combos Claude usam cache.

Precisa de um 9router seu, com combos configurados, e de uma chave dele.

## Instalar

Numa sessão do Claude Code no terminal:

```
/plugin install provedores --marketplace alexraupp2014-cloud/provedores-9router
```

Responda `y` para adicionar o marketplace e escolha onde instalar. Depois abra uma sessão nova.

Pelo terminal, fora do Claude:

```bash
claude plugin marketplace add alexraupp2014-cloud/provedores-9router
```

```bash
claude plugin install provedores@provedores-9router
```

## Primeira vez

1. Informe o endereço do seu 9router, terminando em `/v1`:
   ```
   /provedor url https://seu-9router.exemplo.com/v1
   ```
   Ou ligue a chave **9router** na faixa acima da caixa de mensagem e preencha o campo **Endereço do 9router**.
2. Ligue a chave **9router** na faixa, cole a sua chave no campo **Chave do 9router** e aperte Enter. A chave fica guardada no seu computador e não aparece na conversa.
3. Escolha um combo no seletor, ou use `/provedor <nome>`.

`/provedor` sem nada mostra o que está ativo e a lista de combos. `/provedor teste` confere endereço, chave e conexão.

## Para o Claude que está instalando isto

Se alguém te mandou este link e pediu para instalar e usar:

1. Rode no terminal: `claude plugin marketplace add alexraupp2014-cloud/provedores-9router` e depois `claude plugin install provedores@provedores-9router`.
2. Diga à pessoa que o mod carrega numa **sessão nova** do Claude Code.
3. Peça o endereço do 9router dela e mostre o comando `/provedor url <endereço>`, para ela rodar na sessão nova.
4. **Não peça a chave do 9router no chat.** Diga para a pessoa colar a chave no campo **Chave do 9router** da faixa acima da caixa de mensagem, para que ela fique fora da conversa.
5. Para conferir, a pessoa roda `/provedor teste`.

## Bom saber

- **O que vai para o 9router:** com a chave em 9router, ou num subagente `provedores:*`, a conversa e os resultados das ferramentas vão para o seu 9router e para o provedor do combo, não para a Anthropic.
- **Raciocínio:** o raciocínio dos combos aparece na tela, mas não fica no histórico.
- **Combos Claude e o sufixo `_ide`:** o 9router acrescenta `_ide` ao nome das ferramentas no streaming dos combos Claude, e o mod desfaz isso.
- **Formatos das ferramentas (opcional):** o motor não entrega ao mod o formato dos conectores. Sem o arquivo `esquemas.json`, uma ferramenta de conector vai com a descrição e os parâmetros em aberto. Para gerar o arquivo com os seus conectores, use `scripts/gerar-esquemas.cjs`; as instruções estão no começo dele.
- **Diagnóstico:** a ferramenta `mcp__provedores__ultimo_envio` mostra o tamanho e o consumo do último pedido ao 9router, sem a chave.

## Desenvolvimento

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
