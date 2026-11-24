# MultiDevice v0.6 · Histórico experimental do Stremio

## Ativação por aparelho

1. No navegador já pareado, entre na mesma conta do OpenProfiles e selecione o perfil em **Usar neste aparelho**.
2. Em **Aparelhos e perfis**, confirme que há um Tracking Addon autorizado na conta e que a associação de rede deste navegador está ativa. A associação vale por 24 horas.
3. Abra **Histórico experimental do Stremio** e aceite **Ativar atribuição experimental**. A associação de rede e a instalação do coletor, por si só, mantêm a atribuição desligada.

O diagnóstico do Tracking Addon mostra se cada evento foi atribuído, ignorado como repetição ou ficou sem atribuição. O histórico web lista a maior posição ainda atribuída a cada vídeo de um perfil. Um reinício do vídeo ou um evento fora de ordem com posição menor preserva a posição anterior.

**Desfazer atribuição** remove do cálculo a sessão provável inteira e recupera a maior posição das atribuições restantes. Desativar a opção neste navegador impede novas atribuições e mantém as anteriores disponíveis para revisão. O diagnóstico conserva sua retenção de até sete dias e 200 eventos por conta. As atribuições são guardadas separadamente e continuam disponíveis depois da limpeza do diagnóstico.

## Limites da atribuição

O Tracking Addon recebe `start`, `pause` e `stop` quando um cliente Stremio compatível os envia. As solicitações de `player` documentadas contêm tipo, ID do vídeo, ação, posição e duração. O token do coletor autoriza a recepção de eventos da conta e o protocolo desse recurso não fornece o cookie do navegador pareado, um ID confiável do aparelho ou um ID de sessão de reprodução. [Protocolo oficial de add-ons](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md) · [Stremio Core v0.64.0](https://github.com/Stremio/stremio-core/releases/tag/stremio-core-web-v0.64.0)

A associação usa o hash de rede já mantido pela ponte. Se mais de um navegador pareado tiver uma associação válida com o mesmo IP, o evento fica sem atribuição mesmo que apenas um tenha ativado o experimento. Um único candidato continua sendo uma hipótese. Aparelhos sem associação, NAT, VPN, proxies e mudanças de rede podem produzir correspondências incorretas ou ausentes.

Um `start` elegível abre a sessão provável para o perfil selecionado. `pause` e `stop` exigem essa sessão para o mesmo vídeo. Uma mudança de perfil, atualização de associação, ambiguidade ou desativação interrompe a associação de reprodução. O protocolo também usa `start` para retomadas e pode reenviá-lo após um avanço ou retrocesso no vídeo. Eventos semelhantes após a troca de perfil continuam sujeitos a erro. Repetições exatas do mesmo aparelho provável em até dez segundos são descartadas do histórico experimental. [Eventos de reprodução no protocolo oficial](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md)

A v0.6 cria tabelas separadas de consentimento, atribuições e resultados de diagnóstico no SQLite já utilizado pelo MultiDevice. O seletor v0.5 continua disponível. O progresso do player web e a biblioteca, os add-ons compartilhados, o histórico e o **Continuar assistindo** do Stremio continuam usando seus fluxos atuais.

## Catálogo no aplicativo oficial

O protocolo permite declarar um catálogo próprio, com ID e nome independentes no manifesto, e devolver itens via `catalog` e detalhes via `meta`. Isso permitiria uma seção de consulta chamada **Progresso experimental OpenProfiles**, com a posição exibida como texto nos detalhes. O posicionamento da seção e a apresentação exata dos cartões ainda precisam de validação nos clientes oficiais. [Manifesto e catálogos](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md#content-catalogs) · [Resposta de metadados](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/meta.md)

O catálogo seria somente de leitura. O cliente ignora a resposta de `player`, e o catálogo não controla o offset do player, a interface do **Continuar assistindo** nem o perfil escolhido no navegador. Como o link de um add-on pode ser compartilhado entre aparelhos da conta, um catálogo de progresso exigiria autorização separada, explícita e revogável para cada perfil exposto. O token do Tracking Addon não concede esse acesso. Nesta versão, a seção de progresso está disponível no painel web. [Protocolo oficial de add-ons](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md)
